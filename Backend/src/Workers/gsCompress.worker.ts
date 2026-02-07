import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';

const execPromise = promisify(exec);

export const compressWithGS = async (inputPath: string, outputPath: string) => {
  const gsCommand = os.platform() === 'win32' ? 'gswin64c' : 'gs';
  const absoluteInput = path.resolve(inputPath);
  const absoluteOutput = path.resolve(outputPath);

  if (!fs.existsSync(absoluteInput)) return absoluteInput;
  if (fs.statSync(absoluteInput).size <= 1000 * 1000) return absoluteInput;

  const strategies = [
    { dpi: 72, quality: '/screen', q: 50 },
    { dpi: 60, quality: '/screen', q: 30 }
  ];

  for (const step of strategies) {
    const command = `${gsCommand} -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 \
      -dPDFSETTINGS=${step.quality} -dNOPAUSE -dQUIET -dBATCH \
      -dColorImageResolution=${step.dpi} -dGrayImageResolution=${step.dpi} -dMonoImageResolution=${step.dpi} \
      -dDownsampleColorImages=true -dDownsampleGrayImages=true -dDownsampleMonoImages=true \
      -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
      -dJPEGQ=${step.q} \
      -dEmbedAllFonts=false -dSubsetFonts=true -dCompressFonts=true \
      -sOutputFile="${absoluteOutput}" "${absoluteInput}"`;

    try {
      await execPromise(command);
      if (fs.existsSync(absoluteOutput) && fs.statSync(absoluteOutput).size <= 1000 * 1000) {
        return absoluteOutput;
      }
    } catch (err) {
      console.error(`GS Step failed:`, err);
    }
  }

  try {
    return absoluteOutput;
  } catch (err) {
    console.error("GS Aggressive failed:", err);
    return absoluteInput;
  }
};