import re
import glob

files = glob.glob("src/**/*.ts", recursive=True) + glob.glob("public/**/*.ts", recursive=True) + glob.glob("tests/**/*.ts", recursive=True)

for file in files:
    with open(file, "r", encoding="utf-8") as f:
        content = f.read()

    orig = content
    content = re.sub(r'\(\(\) => false\)\([^)]+\)', 'false', content)
    
    if orig != content:
        with open(file, "w", encoding="utf-8") as f:
            f.write(content)
