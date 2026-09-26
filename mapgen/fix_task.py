with open(r"C:\Users\Corey\.gemini\antigravity\brain\24389142-d215-4144-a2fb-cf7395d00bfe\task.md", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("[ ]", "[x]")

with open(r"C:\Users\Corey\.gemini\antigravity\brain\24389142-d215-4144-a2fb-cf7395d00bfe\task.md", "w", encoding="utf-8") as f:
    f.write(content)
