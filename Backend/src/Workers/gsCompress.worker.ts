import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execPromise = promisify(exec);

export const compressWithGS = async (inputPath:string, outputPath:string) => {
  const gsCommand = os.platform() === 'win32' ? 'gswin64c' : 'gs';
  
  const absoluteInput = path.resolve(inputPath);
  const absoluteOutput = path.resolve(outputPath);

  const command = `${gsCommand} -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${absoluteOutput}" "${absoluteInput}"`;
  
  try {
    await execPromise(command);
    return absoluteOutput;
  } catch (err) {
    console.error("Ghostscript compression failed:", err);
    return absoluteInput; 
  }
};