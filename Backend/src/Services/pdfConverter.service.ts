import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'fs';

type ImageInput = string | Buffer;

export default class PDFHandler {
  private compressToBudget = async (
    input: ImageInput,
    budgetPerImage: number
  ): Promise<Buffer | null> => {
    try {
      let quality = 80;
      let scale = 1.0;
      let buffer = await sharp(input).jpeg({ quality, mozjpeg: true }).toBuffer();

      while (buffer.length > budgetPerImage && (quality > 15 || scale > 0.4)) {
        if (quality > 20) {
          quality -= 15;
        } else {
          scale -= 0.2;
        }

        const pipeline = sharp(input).jpeg({ quality, mozjpeg: true });
        if (scale < 1.0) {
          const metadata = await sharp(input).metadata();
          pipeline.resize(Math.round(metadata.width! * scale));
        }

        buffer = await pipeline.toBuffer();
      }

      return buffer;
    } catch (err: any) {
      console.warn(`[PDFHandler] Skipping unsupported image: ${err.message}`);
      return null;
    }
  };

  createPdfFromImages = async (
    images: ImageInput[],
    outputPath: string
  ): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false, compress: true });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      const totalBudget = 900 * 1024;
      const budgetPerImage = totalBudget / images.length;

      try {
        let addedPages = 0;
        for (const img of images) {
          const compressedBuffer = await this.compressToBudget(img, budgetPerImage);
          if (!compressedBuffer) continue; // Skip unsupported images

          const imgMetadata = await sharp(compressedBuffer).metadata();

          doc.addPage({
            size: [imgMetadata.width!, imgMetadata.height!],
            margin: 0,
          });

          doc.image(compressedBuffer, 0, 0, {
            width: imgMetadata.width,
            height: imgMetadata.height,
          });
          addedPages++;
        }

        if (addedPages === 0) {
          doc.end();
          reject(new Error('No valid images found for PDF generation'));
          return;
        }

        doc.end();
      } catch (error) {
        reject(error);
      }

      stream.on('finish', () => resolve());
      stream.on('error', (err) => reject(err));
    });
  };
}