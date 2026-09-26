with open("public/app.ts", "r", encoding="utf-8") as f:
    code = f.read()

code = code.replace(
    'const classColor = (name: string) => `hsl(${hash(name) % 360} 32% 34%)`;',
    'const classColor = (name: string) => name === "open" ? "#5a6268" : `hsl(${hash(name) % 360} 32% 34%)`;'
)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(code)
print("done")
