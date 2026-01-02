import multer from "multer"

const storage = multer.diskStorage({
  destination: function (req: any, file: any, cb: any) {
    cb(null, 'src/public');
  },
  filename: function (req: any, file: any, cb: any) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix);
  }
})

const upload = multer({ storage: storage });
export default upload;