import re

with open("public/index.html", "r", encoding="utf-8") as f:
    html = f.read()

modal = """
    <dialog id="progressModal" class="app-dialog" style="padding: 20px; width: 300px; text-align: center;">
      <h3 style="margin-top: 0;">Generating Map...</h3>
      <p id="progressStatus" style="font-size: 0.9em; color: #666; margin-bottom: 20px;">Starting...</p>
      <div style="width: 100%; height: 10px; background: #eee; border-radius: 5px; overflow: hidden; margin-bottom: 20px;">
        <div id="progressBar" style="width: 0%; height: 100%; background: #007bff; transition: width 0.1s linear;"></div>
      </div>
      <button id="cancelGeneration" class="primary" style="background: #dc3545;">Cancel Generation</button>
    </dialog>
"""

if 'id="progressModal"' not in html:
    html = html.replace('<script type="module" src="/app.ts"></script>', modal + '\n    <script type="module" src="/app.ts"></script>')
    with open("public/index.html", "w", encoding="utf-8") as f:
        f.write(html)
