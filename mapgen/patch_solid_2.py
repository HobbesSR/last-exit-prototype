import re
import glob

files = glob.glob("src/**/*.ts", recursive=True) + glob.glob("public/**/*.ts", recursive=True) + glob.glob("tests/**/*.ts", recursive=True)

for file in files:
    with open(file, "r", encoding="utf-8") as f:
        content = f.read()
        
    orig = content

    content = re.sub(r',\s*SOLID_CLASS', '', content)
    content = re.sub(r'SOLID_CLASS,\s*', '', content)
    content = re.sub(r',\s*isSolidClass', '', content)
    content = re.sub(r'isSolidClass,\s*', '', content)
    
    # public/app.ts
    content = re.sub(r'const solid = view\.cellSolid\(index\);', 'const solid = false;', content)
    content = re.sub(r'if \(view\.cellSolid\(at\)\) return;', '', content)
    
    # core.ts
    content = re.sub(r'const cell = feature\.y \* grid\.W \+ feature\.x;\s*if \(owner === undefined\) return;', 'if (owner === undefined) return;', content)
    content = re.sub(r'const cell = feature\.y \* grid\.W \+ feature\.x;\s*if \(owner === undefined\) return;', 'if (owner === undefined) return;', content)

    # tests
    content = re.sub(r'assert\.ok\(views\.cellSolid\(cellIndex\)\)', 'assert.ok(false)', content)
    content = re.sub(r'assert\.ok\(!views\.cellSolid\(i\)\)', '', content)
    content = re.sub(r'views\.cellSolid', '(() => false)', content)

    if orig != content:
        with open(file, "w", encoding="utf-8") as f:
            f.write(content)
            
print("Done patching.")
