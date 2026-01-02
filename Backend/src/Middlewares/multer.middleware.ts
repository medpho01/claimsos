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

const upload = multer({ storage: storage });
export default upload;