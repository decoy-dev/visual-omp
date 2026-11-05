export function officeCommand(kind, delay = 1) {
  if (!["docx", "xlsx", "pptx"].includes(kind)) throw new Error("Unknown Office fixture.");
  return `python3 - <<'PY'\n${officePython(kind, delay)}\nPY`;
}

export function officePython(kind, delay = 1) {
  return `import base64, io, os, pathlib, time, zipfile
kind = ${JSON.stringify(kind)}
delay = ${Number(delay)}
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=')
external = os.environ.get('VOMP_OFFICE_EXTERNAL_URL', 'https://example.invalid/external.png' if kind == 'docx' else 'http://127.0.0.1:47832/external.png')
def relationships(items):
    return '<Relationships xmlns="'+REL+'">'+''.join('<Relationship Id="'+i+'" Type="'+R+'/'+t+'" Target="'+v+'"'+(' TargetMode="External"' if e else '')+'/>' for i,t,v,e in items)+'</Relationships>'
def package(revision):
    files = {}
    types = [('rels','application/vnd.openxmlformats-package.relationships+xml'),('xml','application/xml'),('png','image/png')]
    overrides = []
    if kind == 'docx':
        def drawing(relid, linked=False):
            return '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Fixture image"/><a:graphic xmlns:a="'+A+'"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:'+('link' if linked else 'embed')+'="'+relid+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
        files['word/document.xml'] = '<w:document xmlns:w="'+W+'" xmlns:r="'+R+'"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Office fixture revision '+str(revision)+'</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Heading</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p>'+drawing('embedded')+drawing('external', True)+'</w:p><w:p><w:hyperlink r:id="web"><w:r><w:t>Open fixture website</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>'
        files['word/styles.xml'] = '<w:styles xmlns:w="'+W+'"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>'
        files['word/media/image.png'] = png
        files['word/_rels/document.xml.rels'] = relationships([('embedded','image','media/image.png',False),('external','image',external,True),('web','hyperlink','https://example.com/',True),('styles','styles','styles.xml',False)])
        overrides = [('word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),('word/styles.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml')]
        root = 'word/document.xml'
    elif kind == 'xlsx':
        files['xl/workbook.xml'] = '<workbook xmlns="'+S+'" xmlns:r="'+R+'"><sheets><sheet name="Summary and cached values" sheetId="1" r:id="one"/><sheet name="Fifty thousand rows" sheetId="2" r:id="two"/></sheets></workbook>'
        files['xl/_rels/workbook.xml.rels'] = relationships([('one','worksheet','worksheets/sheet1.xml',False),('two','worksheet','worksheets/sheet2.xml',False)])
        files['xl/worksheets/sheet1.xml'] = '<worksheet xmlns="'+S+'"><dimension ref="A1:C3"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Revision '+str(revision)+'</t></is></c><c r="B1"><v>2</v></c><c r="C1"><f>B1*3</f><v>6</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>&lt;img src=x onerror=alert(1)&gt;</t></is></c></row></sheetData></worksheet>'
        rows = ''.join('<row r="'+str(i)+'"><c r="A'+str(i)+'"><v>'+str(i)+'</v></c><c r="B'+str(i)+'" t="inlineStr"><is><t>Row '+str(i)+'</t></is></c></row>' for i in range(1,50001))
        files['xl/worksheets/sheet2.xml'] = '<worksheet xmlns="'+S+'"><dimension ref="A1:B50000"/><sheetData>'+rows+'</sheetData></worksheet>'
        overrides = [('xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),('xl/worksheets/sheet1.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),('xl/worksheets/sheet2.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')]
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
path.write_bytes(package(4)[:-40])
print(str(path.resolve())+' truncated save',flush=True)
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
