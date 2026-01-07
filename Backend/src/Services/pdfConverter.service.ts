import { spawn } from 'child_process';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'fs';
import { promises as fsPromises } from 'fs';

type ImageInput = string | Buffer;

export default class PDFHandler {
  createPdfFromImages = async (
    images: ImageInput[],
    outputPath: string
  ): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false });
      const stream = fs.createWriteStream(outputPath);

      doc.pipe(stream);

      try {
        for (const img of images) {
          const processedImageBuffer = await sharp(img)
            .resize(800)
            .jpeg({ quality: 80 })
            .toBuffer();

          const imgMetadata = await sharp(processedImageBuffer).metadata();

          doc.addPage({
            size: [imgMetadata.width!, imgMetadata.height!],
            margin: 0,
          });

          doc.image(processedImageBuffer, 0, 0, {
            width: imgMetadata.width,
            height: imgMetadata.height,
          });
        }
        doc.end();
      } catch (error) {
        reject(error);
      }
      stream.on('finish', () => resolve());
      stream.on('error', (err) => reject(err));
    });
  };

  compressPdf = async (
    inputPath: string,
    outputPath: string
  ): Promise<void> => {
    const args = [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/screen',
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ];

    return new Promise((resolve, reject) => {
      const command = process.platform === 'win32' ? 'gswin64c' : 'gs';
      const gs = spawn(command, args);

      gs.on('close', async (code) => {
        if (code !== 0) {
          return reject(new Error(`Ghostscript exited with code ${code}`));
        }
        try {
          const stats = await fsPromises.stat(outputPath);
          const sizeInMB = stats.size / (1024 * 1024);
          if (sizeInMB > 1.0) {
            console.warn(`Compressed size: ${sizeInMB.toFixed(2)}MB (Target: <1MB)`);
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      gs.on('error', (err) => reject(err));
    });
  };
}