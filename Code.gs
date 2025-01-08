const CLOUD_FUNCTION_URL = "http://127.0.0.1:5000/"; // Replace with your local server URL
const SHARED_DRIVE_FOLDER_ID = "130qg95OYnWpV6tN9u0hy9nCZmSgGfHAr"; // Replace with your folder ID
const MAX_PAGES_PER_REQUEST = 16;

/**
 * Processes the latest PDF file in a shared drive folder and writes the extracted markdown to Google Sheets.
 *
 * @param {string} folderId The ID of the shared drive folder.
 * @param {string} cloudFunctionUrl The URL of the deployed Cloud Run (or local) function.
 * @customfunction
 */
function processSharedDriveFolder(
  folderId = SHARED_DRIVE_FOLDER_ID,
  cloudFunctionUrl = CLOUD_FUNCTION_URL
) {
  (async () => {
    try {
      // 1) Dynamically load pdf-lib
      const cdnUrl = "https://cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js";
      eval(UrlFetchApp.fetch(cdnUrl).getContentText());

      // Workaround for setTimeout usage in pdf-lib
      const setTimeout = function (fn, t) {
        Utilities.sleep(t);
        return fn();
      };

      // 2) Get the *latest* PDF file in the specified folder
      const latestPdfFile = getLatestPdfFile(folderId);
      if (!latestPdfFile) {
        Logger.log("No PDF found in the folder. Exiting.");
        return;
      }

      const fileName = latestPdfFile.getName();
      const fileId = latestPdfFile.getId();
      const mimeType = latestPdfFile.getMimeType();

      if (mimeType !== "application/pdf") {
        Logger.log(`Latest file (${fileName}) is not a PDF. Exiting.`);
        return;
      }

      // 3) Load the file bytes into pdf-lib
      const fileBlob = latestPdfFile.getBlob();
      const fileBytes = new Uint8Array(fileBlob.getBytes());
      const originalPdfDoc = await PDFLib.PDFDocument.load(fileBytes);
      const totalPages = originalPdfDoc.getPageCount();
      Logger.log(`Processing latest PDF: '${fileName}' with ${totalPages} page(s).`);

      // 4) Split in segments of MAX_PAGES_PER_REQUEST
      for (
        let startPage = 0;
        startPage < totalPages;
        startPage += MAX_PAGES_PER_REQUEST
      ) {
        const endPage = Math.min(startPage + MAX_PAGES_PER_REQUEST, totalPages);

        // Create a new PDFDocument for this segment
        const splitPdfDoc = await PDFLib.PDFDocument.create();

        // Copy pages [startPage ... endPage-1]
        for (let pageIndex = startPage; pageIndex < endPage; pageIndex++) {
          const [copiedPage] = await splitPdfDoc.copyPages(originalPdfDoc, [
            pageIndex,
          ]);
          splitPdfDoc.addPage(copiedPage);
        }

        // Save the segment as a PDF blob
        const splitPdfBytes = await splitPdfDoc.save();
        const segmentFileName = `${fileName}_${startPage + 1}-${endPage}.pdf`;
        const splitPdfBlob = Utilities.newBlob(
          splitPdfBytes,
          MimeType.PDF,
          segmentFileName
        );

        Logger.log(
          `Sending segment to Cloud Function: 
           File: ${segmentFileName}, 
           Page Range: ${startPage + 1}-${endPage}, 
           Blob Size: ${splitPdfBytes.length} bytes.`
        );

        // 5) Send this segment to the Cloud Function
        const pagesInSegment = endPage - startPage;
        const startTime = new Date();
        const response = UrlFetchApp.fetch(cloudFunctionUrl, {
          method: "post",
          muteHttpExceptions: true,
          payload: splitPdfBlob,
          headers: {
            "Content-Type": "application/octet-stream",
          },
        });
        const endTime = new Date();
        const elapsedSeconds = (endTime - startTime) / 1000;

        // 6) Handle the response (Markdown) from Cloud Function
        if (response.getResponseCode() === 200) {
          const markdown = response.getContentText();

          // Log how long the cloud function took
          Logger.log(
            `Cloud Function processed segment (${pagesInSegment} page(s)) in ${elapsedSeconds.toFixed(
              2
            )} seconds.`
          );

          Logger.log(
            `Markdown returned for pages ${startPage + 1}-${endPage}:\n${markdown}`
          );

          // 7) Process the Markdown
          parseAndWriteMarkdown(markdown);
        } else {
          throw new Error(`Error from Cloud Function: ${response.getContentText()}`);
        }
      }
    } catch (err) {
      Logger.log(`Unexpected error in processSharedDriveFolder: ${err}`);
    }
  })();
}

/**
 * Splits the Markdown based on markers (## Page X or --- Page X ---),
 * extracts the real page number from the marker, and writes each page to its own
 * sheet named `dNN`. Unused sheets starting with 'd' are deleted at the end.
 *
 * @param {string} markdown  Full Markdown returned by the Cloud Function.
 */
function parseAndWriteMarkdown(markdown) {
  // We'll keep track of which page numbers were actually used
  const usedPages = [];

  // We'll split while KEEPING the marker lines using a capturing group.
  const parts = markdown.split(/(## Page \d+|--- Page \d+ ---)/);

  for (let i = 0; i < parts.length; i++) {
    const markerLine = parts[i].trim();

    // Check if this part is indeed a page marker
    const isMarker = markerLine.match(/^## Page \d+$|^--- Page \d+ ---$/);
    if (isMarker) {
      // Extract the actual page number
      const numMatch = markerLine.match(/\d+/); // find digits
      if (!numMatch) continue;

      const actualPageNumber = parseInt(numMatch[0], 10);
      // Keep track so we don't delete it later
      usedPages.push(actualPageNumber);

      // The next chunk is the page content
      const pageContent = (parts[i + 1] || "").trim();
      i++; // skip that chunk in the loop

      if (pageContent) {
        // Construct the sheet name: e.g. page 1 => d01
        const sheetName = `d${String(actualPageNumber).padStart(2, "0")}`;
        Logger.log(`Markdown for ${sheetName}:\n${pageContent}`);
        writeMarkdownToSheet(sheetName, pageContent);
      }
    }
  }

  // Finally, remove any "dXX" sheets that were not used
  removeUnusedSheets(usedPages);
}

/**
 * Writes Markdown content to a sheet named `sheetName`.
 * - If the sheet already exists, its contents are cleared.
 * - If it doesn't exist, it's created.
 *
 * @param {string} sheetName - The name of the sheet to create or clear.
 * @param {string} markdownContent - The Markdown content to write.
 */
function writeMarkdownToSheet(sheetName, markdownContent) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);

  // If sheet exists, clear it; if not, create it
  if (sheet) {
    sheet.clearContents();
  } else {
    sheet = ss.insertSheet(sheetName);
  }

  // Split Markdown into lines
  const lines = markdownContent.split("\n");

  let rowIndex = 1;
  lines.forEach((line) => {
    if (line.startsWith("|") && line.endsWith("|")) {
      // Split the columns
      let cells = line.split("|");

      // Remove leading/trailing empty elements due to '|' but keep empty columns
      if (cells.length > 1 && cells[0].trim() === "") {
        cells.shift();
      }
      if (cells.length > 1 && cells[cells.length - 1].trim() === "") {
        cells.pop();
      }

      // Trim each cell
      cells = cells.map((c) => c.trim());

      // Skip if there's nothing
      if (cells.length === 0) return;

      sheet.getRange(rowIndex, 1, 1, cells.length).setValues([cells]);
      rowIndex++;
    } else {
      // Write other content as single-row text
      sheet.getRange(rowIndex, 1).setValue(line);
      rowIndex++;
    }
  });
}

/**
 * Deletes all sheets that start with "d" but are not in the used page list.
 *
 * @param {number[]} usedPages - Array of page numbers that were used.
 */
function removeUnusedSheets(usedPages) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const allSheets = ss.getSheets();

  // Create a set of used "dXX" names
  const usedSheetNames = usedPages.map((pageNum) =>
    "d" + String(pageNum).padStart(2, "0")
  );

  allSheets.forEach((sheet) => {
    const name = sheet.getName();
    // If sheet starts with "d" and is not in the used list, remove it
    if (name.startsWith("d") && !usedSheetNames.includes(name)) {
      ss.deleteSheet(sheet);
    }
  });
}

/**
 * Retrieves the latest PDF file in the specified folder (by last updated time).
 *
 * @param {string} folderId The ID of the folder.
 * @return {File | null} The latest PDF file, or null if none found.
 */
function getLatestPdfFile(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const fileIterator = folder.getFilesByType(MimeType.PDF);

  let latestFile = null;
  while (fileIterator.hasNext()) {
    const file = fileIterator.next();
    if (!latestFile || file.getLastUpdated() > latestFile.getLastUpdated()) {
      latestFile = file;
    }
  }
  return latestFile;
}
