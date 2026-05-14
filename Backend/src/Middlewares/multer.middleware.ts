import multer from "multer"
import fs from 'fs';

const storage = multer.diskStorage({
  destination: function (req: any, file: any, cb: any) {
    const dir = 'src/public';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req: any, file: any, cb: any) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix);
  }
})

const fileFilter = (req: any, file: any, cb: any) => {
  const allowedMimeTypes = [
    // Standard Images
    'image/jpeg', 
    'image/png', 
    'image/webp', 
    // Apple Devices (iPhone)
    'image/heic', 
    'image/heif',
    // Documents
    'application/pdf',
    'application/msword', // .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/vnd.ms-excel', // .xls
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'text/csv' // .csv
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Only Images, PDFs, and standard Office documents are allowed.`), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB maximum file size
  }
});
export default upload;

// In-memory variant for routes that need the file as a Buffer (the doctor +
// hospital-profile document routes upload straight to S3 from the request
// path). Shares the same MIME allow-list as the disk variant; was previously
// inlined in each route file with no MIME filter and a 100 MB limit — much
// looser than the rest of the system. Memory-stored, 25 MB cap.
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: fileFilter,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});