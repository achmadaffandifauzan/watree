import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firestore";
import bucket from "@/lib/cloudBucket";
import {
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  getDoc,
} from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import { parse, isValid } from "date-fns";

const validateRow = (row: any) => {
  let { Date: date, Time: time, Flowrate: flowrate } = row;
  try {
    // Validate and parse Date
    const parsedDate = parse(date, "d/MM/yyyy", new Date());
    if (!isValid(parsedDate)) {
      console.log("NULL_1");
      return null;
    }
    // Handle Time value
    if (typeof time === "number") {
      const totalSeconds = Math.round(time * 24 * 60 * 60);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      time = `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    // Split time into hours, minutes, and seconds
    let [hours, minutes, seconds] = time.split(".").map(Number);
    if (seconds === undefined) {
      [hours, minutes, seconds] = time.split(":").map(Number);
    }

    // Combine Date and Time into a single timestamp
    const timestamp = new Date(parsedDate.setHours(hours, minutes, seconds));

    if (!timestamp || !flowrate) {
      return null;
    }
    return {
      timestamp: timestamp.toISOString(), // Converting to ISO string for Firestore
      flowrate: flowrate,
    };
  } catch (error) {
    // console.log("NULL_4", error);
    return null;
  }
};

export const POST = async (req: NextRequest) => {
  try {
    const form = await req.formData();
    const file = form.get("file") as File;
    if (!file) {
      return new Response("Tidak ada dokumen", { status: 400 });
    }
    // Check file size
    const maxSizeBytes = 20 * 1024 * 1024; // 20MB
    if (file.size > maxSizeBytes) {
      return new Response("File terlalu besar (maksimal 20MB)", {
        status: 400,
      });
    }
    // Check if the uploaded file is an XLSX
    const fileType = file.type.split("/")[1];
    if (fileType !== "vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return new Response("File harus berformat XLSX", { status: 400 });
    }

    // Read the file data and create a Buffer
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });

    const treesCollection = collection(db, "trees");

    for (let i = 0; i < workbook.SheetNames.length; i++) {
      const sheetName = workbook.SheetNames[i];
      const treeId = sheetName;
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet);

      const treeDocRef = doc(treesCollection, treeId);
      const treeDoc = await getDoc(treeDocRef);

      let treeProgress = [];
      if (treeDoc.exists()) {
        treeProgress = treeDoc.data().progress || [];
      }

      for (const row of rows) {
        try {
          const validatedRow = validateRow(row);
          if (validatedRow) {
            // Check if this specific progress entry already exists
            const existingEntryIndex = treeProgress.findIndex(
              (entry: any) => entry.timestamp === validatedRow.timestamp
            );

            if (existingEntryIndex === -1) {
              // Add new entry
              treeProgress.push(validatedRow);
            } else {
              // Update existing entry
              treeProgress[existingEntryIndex] = validatedRow;
            }
          }
        } catch (error: any) {
          console.error(
            `Error processing row in sheet ${sheetName}: ${error.message}`
          );
        }
      }

      await setDoc(
        treeDocRef,
        { treeId, progress: treeProgress },
        { merge: true }
      );
    }
    // Process the excel upload to cloud bucket
    const xlsxBuffer = Buffer.from(buffer);
    const xlsx_id = uuidv4();
    // Generate a unique filename for the EXCEL
    const filename = `${xlsx_id}.xlsx`;
    const folderPath = "xlsx";
    const destination = `${folderPath}/${filename}`;

    // Upload the xlsx to Gcloud bucket
    await bucket.file(destination).save(xlsxBuffer, {
      metadata: {
        contentType: file.type,
      },
    });
    // Get the public URL of the uploaded csv
    const csvUrl = `https://storage.googleapis.com/${bucket.name}/${destination}`;
    // Save record with csv URL in Firestore
    await setDoc(doc(db, "archive_file", xlsx_id), {
      id: xlsx_id,
      csvUrl,
      uploaded: new Date().toISOString(),
    });

    return new Response("Sukses mengupdate data pohon", { status: 200 });
  } catch (error) {
    console.error("Error processing XLSX file:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
};