import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/**
 * Loads an .xlsx file into ExcelJS. Workbooks built in Excel often carry
 * defined names (print areas written as formulas, for example) that ExcelJS
 * cannot parse and fails on; they play no part in reading cell data, so they
 * are removed from the package first.
 */
export async function loadWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file('xl/workbook.xml');
  if (entry) {
    const xml = await entry.async('string');
    zip.file('xl/workbook.xml', xml.replace(/<definedNames>[\s\S]*?<\/definedNames>/, ''));
  }
  const cleaned = await zip.generateAsync({ type: 'nodebuffer' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(cleaned as unknown as ArrayBuffer);
  return workbook;
}
