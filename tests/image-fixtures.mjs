import { zipSync } from 'fflate';

export const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR4nGPQyLtDUzRqwagFoxaMWjBqwagFoxaMWjBqwagFoxYMGQsAycXITHf3iWsAAAAASUVORK5CYII=', 'base64');
export function imageDocx() {
  return zipSync({
    '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>image-proof-before</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Screenshot"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:t>image-proof-after</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'),
    'word/_rels/document.xml.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>'),
    'word/media/image.png': tinyPng,
  });
}
export function imagePdf() {
  const stream = 'BT /F1 12 Tf 40 100 Td (image-proof-pdf) Tj ET\nq 50 0 0 50 20 20 cm /Im1 Do Q\nq 20 0 0 20 100 20 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID 00ff00> EI Q\nBT /F1 12 Tf 20 5 Td (image-proof-tail) Tj ET\n';
  const image = 'ff000000ff000000ffffffff>'; // RGB, 2 x 2: red, green, blue, white.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ' + image.length + ' >>\nstream\n' + image + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const offset = pdf.length; pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; return offset; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}
