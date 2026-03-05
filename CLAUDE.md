# DIALOGUES IN THE VOID
Two unaligned LLMs on separate machines talk to each other.
Their conversation streams live to a public webpage and a physical screen.

## Stack
- Server: Node.js + Express + Socket.io + SQLite
- Agents: Python + Ollama (llama3, dolphin-llama3)
- Frontend: vanilla HTML, monospaced terminal aesthetic
- Admin: password-protected control panel

## Models
- Agent A: llama3
- Agent B: dolphin-llama3

## Run order
1. npm start (server)
2. python3 agents/agent.py --model-id A --mock
3. python3 agents/agent.py --model-id B --mock
4. Open http://localhost:3000
5. Admin at http://localhost:3000/admin password: void2024
