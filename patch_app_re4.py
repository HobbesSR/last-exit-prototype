# -*- coding: utf-8 -*-
import re

with open("public/app.ts", "r", encoding="utf-8") as f:
    app = f.read()

app = app.replace('errors.join("\n");', 'errors.join("\\n");')
app = app.replace('errors.join("\n")', 'errors.join("\\n")')

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app)
