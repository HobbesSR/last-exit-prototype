import glob

for fpath in glob.glob("tests/*.test.ts"):
    with open(fpath, "r", encoding="utf-8") as f:
        c = f.read()
    c = c.replace('edges: { N: "......", E: "......", S: "......", W: "......" }', 'edges: { N: ["any","any","any","any","any","any"], E: ["any","any","any","any","any","any"], S: ["any","any","any","any","any","any"], W: ["any","any","any","any","any","any"] }')
    c = c.replace('edges: { N: ".....#" }', 'edges: { N: ["any","any","any","any","any","wall"] }')
    c = c.replace('edges: { S: "#....." }', 'edges: { S: ["wall","any","any","any","any","any"] }')
    c = c.replace('edges: { E: ".....#" }', 'edges: { E: ["any","any","any","any","any","wall"] }')
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(c)

print("patched tests")
