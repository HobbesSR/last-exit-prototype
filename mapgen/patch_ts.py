import re
import glob

files = glob.glob("src/**/*.ts", recursive=True) + glob.glob("public/**/*.ts", recursive=True) + glob.glob("tests/**/*.ts", recursive=True)

for file in files:
    with open(file, "r", encoding="utf-8") as f:
        content = f.read()
        
    orig = content

    content = re.sub(r'const solid = \(\(\) => false\)\(index\);', 'const solid = false;', content)
    content = re.sub(r'\(\(\) => false\)\([a-zA-Z0-9_]+\)', 'false', content)
    
    # Check for remaining SOLID_CLASS and isSolidClass
    content = re.sub(r'isSolidClass\([^\)]+\)', 'false', content)
    content = re.sub(r'SOLID_CLASS', '"solid"', content)
    content = re.sub(r'import\s+\{[^\}]*\}\s+from\s+["\'][^"\']+["\'];', lambda m: re.sub(r',\s*"solid"|(?<=\{)\s*"solid"\s*,?|,\s*false|(?<=\{)\s*false\s*,?', '', m.group(0)), content)
    
    # core.ts unused cell
    if file.endswith("core.ts"):
        content = re.sub(r'const cell = feature\.y \* grid\.W \+ feature\.x;\s*if \(owner === undefined\) return;', 'if (owner === undefined) return;', content)
        
    if orig != content:
        with open(file, "w", encoding="utf-8") as f:
            f.write(content)

print("Fixed")
