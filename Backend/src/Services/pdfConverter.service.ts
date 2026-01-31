import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'fs';

type ImageInput = string | Buffer;

export default class PDFHandler {
  createPdfFromImages = async (
    images: ImageInput[],
    outputPath: string
  ): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      const doc = new PDFDocument({ 
        autoFirstPage: false,
        compress: true,
        info: { Producer: '', Creator: '' }
      });
      
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      try {
        for (const img of images) {
          const processedImageBuffer = await sharp(img)
            .resize({ 
              width: 600,
              withoutEnlargement: true 
            })
            .jpeg({ 
              quality: 30,
              chromaSubsampling: '4:2:0'
            })
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
}