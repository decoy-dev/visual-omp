export function officeCommand(kind, delay = 1, truncate = true) {
  if (!["docx", "xlsx", "pptx"].includes(kind)) throw new Error("Unknown Office fixture.");
  return `python3 - <<'PY'\n${officePython(kind, delay, truncate)}\nPY`;
}

export function officePython(kind, delay = 1, truncate = true) {
  return `import io, os, pathlib, struct, time, zipfile, zlib
kind = ${JSON.stringify(kind)}
delay = ${Number(delay)}
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
# The old fixture was a single opaque white pixel, invisible on document paper.
def chunk(name, data):
    return struct.pack('>I', len(data))+name+data+struct.pack('>I', zlib.crc32(name+data) & 0xffffffff)
width, height = 480, 160
pixels = bytearray()
for y in range(height):
    pixels.append(0)
    for x in range(width):
        bar = next((i for i in range(4) if 36+i*110 <= x < 108+i*110 and 136-(40+i*22) <= y < 136), None)
        color = (30, 120, 122) if bar is not None else ((210, 218, 220) if y == 136 else (241, 245, 245))
        pixels.extend(color)
png = b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress(bytes(pixels)))+chunk(b'IEND', b'')
external = os.environ.get('VOMP_OFFICE_EXTERNAL_URL', 'https://example.invalid/external.png' if kind == 'docx' else 'http://127.0.0.1:47832/external.png')
def relationships(items):
    return '<Relationships xmlns="'+REL+'">'+''.join('<Relationship Id="'+i+'" Type="'+R+'/'+t+'" Target="'+v+'"'+(' TargetMode="External"' if e else '')+'/>' for i,t,v,e in items)+'</Relationships>'
def package(revision):
    files = {}
    types = [('rels','application/vnd.openxmlformats-package.relationships+xml'),('xml','application/xml'),('png','image/png')]
    overrides = []
    if kind == 'docx':
        def paragraph(text, style=None, numbering=None):
            props = ('<w:pStyle w:val="'+style+'"/>' if style else '')+('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="'+str(numbering)+'"/></w:numPr>' if numbering else '')
            return '<w:p><w:pPr>'+props+'</w:pPr><w:r><w:t>'+text+'</w:t></w:r></w:p>'
        def drawing(relid, linked=False):
            return '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="4572000" cy="1524000"/><wp:docPr id="'+('2' if linked else '1')+'" name="Quarterly delivery chart" descr="Four teal bars increase from left to right"/><a:graphic xmlns:a="'+A+'"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="Delivery chart"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:'+('link' if linked else 'embed')+'="'+relid+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="1524000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
        body = paragraph('Quarterly delivery review', 'Title')+paragraph('Office fixture revision '+str(revision), 'Subtitle')
        body += paragraph('Overview', 'Heading1')+paragraph('This sample reviews a small delivery programme. Each save updates the revision above while the report keeps its text, lists, table and embedded chart.')
        body += paragraph('Completed work', 'Heading2')+paragraph('Prepared the document preview and checked page layout.', numbering=1)+paragraph('Reviewed cached workbook values and large-sheet navigation.', numbering=1)
        body += paragraph('Next steps', 'Heading2')+paragraph('Review the summary with the project team.', numbering=2)+paragraph('Confirm the next delivery date.', numbering=2)
        body += paragraph('Delivery summary', 'Heading1')+paragraph('The figures below are illustrative fixture data. They exercise table borders, shaded headings and multiple rows.')
        table = '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>'+''.join('<w:'+edge+' w:val="single" w:sz="4" w:color="CBD5D5"/>' for edge in ['top','left','bottom','right','insideH','insideV'])+'</w:tblBorders></w:tblPr><w:tblGrid>'+('<w:gridCol w:w="3120"/>'*3)+'</w:tblGrid>'
        for index, values in enumerate([['Workstream','Owner','Status'],['Document preview','Design','Ready'],['Workbook review','Finance','In review'],['Delivery checks','Operations','Complete']]):
            table += '<w:tr>'+''.join('<w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/><w:shd w:fill="'+('DDECEC' if index == 0 else 'F6F8F8')+'"/></w:tcPr>'+paragraph(value)+'</w:tc>' for value in values)+'</w:tr>'
        body += table+'</w:tbl>'+paragraph('Delivery trend', 'Heading1')+'<w:p>'+drawing('embedded')+'</w:p>'+paragraph('Figure 1. Completed deliveries increase across four sample periods.', 'Caption')
        body += paragraph('External resource checks', 'Heading2')+paragraph('The linked image below must remain blocked. The website link opens only after an explicit click.')+'<w:p>'+drawing('external', True)+'</w:p><w:p><w:hyperlink r:id="web"><w:r><w:rPr><w:color w:val="1E787A"/><w:u w:val="single"/></w:rPr><w:t>Open fixture website</w:t></w:r></w:hyperlink></w:p>'
        files['word/document.xml'] = '<w:document xmlns:w="'+W+'" xmlns:r="'+R+'"><w:body>'+body+'<w:sectPr><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="1440" w:bottom="720" w:left="1440" w:footer="360"/></w:sectPr></w:body></w:document>'
        styles = [('Title', '40', '1E484A'),('Subtitle','22','647475'),('Heading1','28','1E484A'),('Heading2','23','1E484A'),('Caption','18','647475')]
        files['word/styles.xml'] = '<w:styles xmlns:w="'+W+'"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>'+''.join('<w:style w:type="paragraph" w:styleId="'+name+'"><w:name w:val="'+name+'"/><w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr><w:rPr><w:sz w:val="'+size+'"/><w:color w:val="'+color+'"/>'+('<w:b/>' if name in ['Title','Heading1','Heading2'] else '')+'</w:rPr></w:style>' for name,size,color in styles)+'</w:styles>'
        files['word/numbering.xml'] = '<w:numbering xmlns:w="'+W+'">'+''.join('<w:abstractNum w:abstractNumId="'+str(i)+'"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="'+fmt+'"/><w:lvlText w:val="'+text+'"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="'+str(i)+'"><w:abstractNumId w:val="'+str(i)+'"/></w:num>' for i,fmt,text in [(1,'bullet','•'),(2,'decimal','%1.')])+'</w:numbering>'
        files['word/footer1.xml'] = '<w:ftr xmlns:w="'+W+'">'+paragraph('visual-omp preview fixture | Illustrative data', 'Caption')+'</w:ftr>'
        files['word/media/image.png'] = png
        files['word/_rels/document.xml.rels'] = relationships([('embedded','image','media/image.png',False),('external','image',external,True),('web','hyperlink','https://example.com/',True),('styles','styles','styles.xml',False),('numbering','numbering','numbering.xml',False),('footer','footer','footer1.xml',False)])
        overrides = [('word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),('word/styles.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'),('word/numbering.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'),('word/footer1.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml')]
        root = 'word/document.xml'
    elif kind == 'xlsx':
        files['xl/workbook.xml'] = '<workbook xmlns="'+S+'" xmlns:r="'+R+'"><sheets><sheet name="Summary and cached values" sheetId="1" r:id="one"/><sheet name="Fifty thousand rows" sheetId="2" r:id="two"/></sheets></workbook>'
        files['xl/_rels/workbook.xml.rels'] = relationships([('one','worksheet','worksheets/sheet1.xml',False),('two','worksheet','worksheets/sheet2.xml',False),('styles','styles','styles.xml',False)])
        summary = '<row r="1"><c r="A1" t="inlineStr"><is><t>Revision '+str(revision)+'</t></is></c><c r="B1"><v>2</v></c><c r="C1"><f>B1*3</f><v>6</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>&lt;img src=x onerror=alert(1)&gt;</t></is></c></row>'
        for i, values in enumerate([['Delivery summary','Planned','Completed'],['Documents',12,10],['Workbooks',8,6],['Presentations',5,4]], 4):
            summary += '<row r="'+str(i)+'">'+''.join('<c r="'+col+str(i)+'"'+(' t="inlineStr" s="1"><is><t>'+value+'</t></is>' if isinstance(value,str) else ' s="2"><v>'+str(value)+'</v>')+'</c>' for col,value in zip('ABC',values))+'</row>'
        summary += '<row r="8"><c r="A8" t="inlineStr" s="1"><is><t>Total</t></is></c><c r="B8" s="2"><f>SUM(B5:B7)</f><v>25</v></c><c r="C8" s="2"><f>SUM(C5:C7)</f><v>20</v></c></row><row r="10"><c r="A10" t="inlineStr"><is><t>Illustrative fixture data. Formula results are cached.</t></is></c></row>'
        files['xl/worksheets/sheet1.xml'] = '<worksheet xmlns="'+S+'"><dimension ref="A1:C10"/><cols><col min="1" max="1" width="58" customWidth="1"/><col min="2" max="3" width="18" customWidth="1"/></cols><sheetData>'+summary+'</sheetData></worksheet>'
        files['xl/styles.xml'] = '<styleSheet xmlns="'+S+'"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FF1E484A"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" numFmtId="0"/><xf fontId="1" fillId="0" borderId="0" numFmtId="0" applyFont="1"/><xf fontId="0" fillId="0" borderId="0" numFmtId="3" applyNumberFormat="1"/></cellXfs></styleSheet>'
        rows = ''.join('<row r="'+str(i)+'"><c r="A'+str(i)+'"><v>'+str(i)+'</v></c><c r="B'+str(i)+'" t="inlineStr"><is><t>Row '+str(i)+'</t></is></c></row>' for i in range(1,50001))
        files['xl/worksheets/sheet2.xml'] = '<worksheet xmlns="'+S+'"><dimension ref="A1:B50000"/><sheetData>'+rows+'</sheetData></worksheet>'
        overrides = [('xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),('xl/worksheets/sheet1.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),('xl/worksheets/sheet2.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')]
        overrides.append(('xl/styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'))
        root = 'xl/workbook.xml'
    else:
        files['ppt/presentation.xml'] = '<p:presentation xmlns:p="'+P+'" xmlns:r="'+R+'"><p:sldIdLst><p:sldId id="256" r:id="one"/><p:sldId id="257" r:id="two"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
        files['ppt/_rels/presentation.xml.rels'] = relationships([('one','slide','slides/slide1.xml',False),('two','slide','slides/slide2.xml',False)])
        for i in [1,2]:
            files['ppt/slides/slide'+str(i)+'.xml'] = '<p:sld xmlns:p="'+P+'" xmlns:a="'+A+'" xmlns:r="'+R+'"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Slide '+str(i)+', revision '+str(revision)+'</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="External image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="remote"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="2286000"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
            files['ppt/slides/_rels/slide'+str(i)+'.xml.rels'] = relationships([('remote','image',external,True)])
        overrides = [('ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),('ppt/slides/slide1.xml','application/vnd.openxmlformats-officedocument.presentationml.slide+xml'),('ppt/slides/slide2.xml','application/vnd.openxmlformats-officedocument.presentationml.slide+xml')]
        root = 'ppt/presentation.xml'
    files['_rels/.rels'] = relationships([('root','officeDocument',root,False)])
    files['[Content_Types].xml'] = '<Types xmlns="'+CT+'">'+''.join('<Default Extension="'+e+'" ContentType="'+t+'"/>' for e,t in types)+''.join('<Override PartName="/'+p+'" ContentType="'+t+'"/>' for p,t in overrides)+'</Types>'
    data = io.BytesIO()
    with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as archive:
        for path, value in files.items(): archive.writestr(path,value)
    return data.getvalue()
path = pathlib.Path('office.'+kind)
for revision in [1,2,3]:
    path.write_bytes(package(revision))
    print(str(path.resolve())+' save '+str(revision),flush=True)
    time.sleep(delay)
path.write_bytes(package(4)[:-40] if ${truncate ? "True" : "False"} else package(3))
print(str(path.resolve())+' ${truncate ? "truncated save" : "complete save"}',flush=True)
time.sleep(delay)
bomb = pathlib.Path('bomb.'+kind)
with zipfile.ZipFile(bomb,'w',zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('oversized.bin', b'0'*(64*1024*1024+1))
print(str(bomb.resolve())+' unsafe ZIP bomb',flush=True)
if kind == 'pptx':
    macro = io.BytesIO(package(1))
    with zipfile.ZipFile(macro,'a',zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('ppt/vbaProject.bin', b'macro fixture, never executable')
    pathlib.Path('macro.pptm').write_bytes(macro.getvalue())
    pathlib.Path('macro-disguised.pptx').write_bytes(macro.getvalue())
    print(str(pathlib.Path('macro.pptm').resolve())+' forbidden macro-enabled extension',flush=True)
    print(str(pathlib.Path('macro-disguised.pptx').resolve())+' forbidden macro content',flush=True)
`;
}
