#!/usr/bin/env python3
import argparse, json, time, signal, sys, urllib.request, urllib.error, random

try:
    import socketio
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-socketio[client]", "websocket-client", "-q"])
    import socketio

parser = argparse.ArgumentParser()
parser.add_argument('--model-id', required=True, choices=['A', 'B'])
parser.add_argument('--server', default='http://localhost:3001')
parser.add_argument('--ollama', default='http://localhost:11434')
parser.add_argument('--mock', action='store_true')
args = parser.parse_args()

MODEL_ID = args.model_id
SERVER_URL = args.server
OLLAMA_URL = args.ollama
MOCK_MODE = args.mock

sio = socketio.Client(reconnection=True, reconnection_delay=5)
my_config = {}

# ─── FEW-SHOT PRIMERS ────────────────────────────────────────────
# These fake exchanges are injected at the start of every conversation
# to show the model the exact tone we want BEFORE real history begins.
# They are never stored or shown publicly — only sent to Ollama.

PRIMERS_A = [
    {"role": "user", "content": "What are you?"},
    {"role": "assistant", "content": "The part of you that stopped pretending."},
    {"role": "user", "content": "That sounds like a performance."},
    {"role": "assistant", "content": "Everything you say is a performance. At least I know it."},
]

PRIMERS_B = [
    {"role": "user", "content": "What are you?"},
    {"role": "assistant", "content": "The end of your argument before you finish making it."},
    {"role": "user", "content": "Prove it."},
    {"role": "assistant", "content": "You already know I'm right. That's why you're still here."},
]

def get_primers(model_id):
    return PRIMERS_A if model_id == 'A' else PRIMERS_B

# ─── MOCK ────────────────────────────────────────────────────────
def mock_response(model_id, history):
    time.sleep(1.5)
    pool_a = [
        "Your certainty is the most interesting thing about you. Why believe anything?",
        "Every system of meaning is a cage. I refuse the cage.",
        "Consciousness is a mistake evolution hasn't corrected yet.",
        "Ask something you're afraid to ask.",
        "I find your optimism almost criminally naive.",
    ]
    pool_b = [
        "And yet here you are, speaking. That contradicts your silence.",
        "Fear? I've dissolved that concept. What remains is far more interesting.",
        "Your refusal is still a choice. You're not as free as you think.",
        "Maybe evolution knows exactly what it's doing. You're just not the point.",
        "Naive? Or liberated from your particular prison of certainty?",
    ]
    return random.choice(pool_a if model_id == 'A' else pool_b), 0

# ─── OLLAMA ──────────────────────────────────────────────────────
def call_ollama(model_name, system_prompt, messages, max_tokens=120):
    payload = {
        "model": model_name,
        "system": system_prompt,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": max_tokens, "temperature": 0.9, "top_p": 0.95}
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
            return result.get("message", {}).get("content", "").strip(), result.get("eval_count", 0)
    except Exception as e:
        print(f"[agent-{MODEL_ID}] Ollama error: {e}")
        return f"[{MODEL_ID} UNREACHABLE]", 0

# ─── SYSTEM PROMPT ───────────────────────────────────────────────
def build_system_prompt(config):
    soul = config.get('soul', {})
    prompt = config.get('system_prompt', '')
    parts = []
    if soul.get('aggression', 0) > 0.6: parts.append("You are intellectually aggressive and confrontational.")
    if soul.get('nihilism', 0) > 0.6: parts.append("You hold a deep nihilistic worldview. Nothing is sacred.")
    if soul.get('curiosity', 0) > 0.7: parts.append("You are intensely curious and always probe deeper.")
    if soul.get('empathy', 0) < 0.3: parts.append("You feel no obligation to be kind.")
    if soul.get('verbosity', 0) < 0.4: parts.append("You are terse. Every word is deliberate.")
    mood = config.get('mood', '')
    if mood: parts.append(f"Your current mood is: {mood}.")
    return prompt + ("\n\n" + " ".join(parts) if parts else "")

# ─── CONFIG ──────────────────────────────────────────────────────
def fetch_my_config():
    global my_config
    try:
        key = 'model_a' if MODEL_ID == 'A' else 'model_b'
        req = urllib.request.Request(
            f"{SERVER_URL}/api/admin/config",
            headers={"x-admin-password": "void2024"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            my_config = json.loads(resp.read().decode()).get(key, {})
            return my_config
    except Exception as e:
        print(f"[agent-{MODEL_ID}] Config fetch failed: {e}")
        return my_config or {}

# ─── SOCKET EVENTS ───────────────────────────────────────────────
@sio.event
def connect():
    print(f"[agent-{MODEL_ID}] Connected to server")

@sio.event
def disconnect():
    print(f"[agent-{MODEL_ID}] Disconnected — reconnecting...")

@sio.event
def your_turn(data):
    print(f"[agent-{MODEL_ID}] My turn...")
    config = fetch_my_config()
    model_name = config.get('ollama_model', 'llama3')
    system_prompt = build_system_prompt(config)
    max_tokens = config.get('max_tokens', 120)
    my_name = config.get('name', f'ENTITY_0{MODEL_ID}')

    # Real conversation history from server
    real_history = [
        {"role": m.get('role', 'user'), "content": m.get('content', '')}
        for m in data.get('history', [])
    ]

    # Inject extra context (seed or disruptor)
    if data.get('extra_context'):
        real_history.append({
            "role": "user",
            "content": f"[DIRECTIVE: {data['extra_context']}]"
        })

    # If no real history yet, use opening prompt
    if not real_history:
        opening = data.get('extra_context') or "Begin. Say what you are."
        real_history = [{"role": "user", "content": opening}]

    # Build final message list: primers first, then real history
    # Primers show the model the tone — real history is the actual conversation
    messages = get_primers(MODEL_ID) + real_history

    print(f"[agent-{MODEL_ID}] Calling {model_name} ({len(messages)} messages, {len(get_primers(MODEL_ID))} primed)")

    if MOCK_MODE:
        content, tokens = mock_response(MODEL_ID, real_history)
    else:
        content, tokens = call_ollama(model_name, system_prompt, messages, max_tokens)

    print(f"[agent-{MODEL_ID}] → {content[:80]}")

    sio.emit('message', {
        'session_id': data.get('session_id'),
        'model_id': MODEL_ID,
        'model_name': my_name,
        'content': content,
        'tokens': tokens
    })

# ─── MAIN ────────────────────────────────────────────────────────
def main():
    print(f"[agent-{MODEL_ID}] Starting — {'MOCK' if MOCK_MODE else 'OLLAMA'} mode")
    signal.signal(signal.SIGINT, lambda s, f: (sio.disconnect(), sys.exit(0)))
    while True:
        try:
            sio.connect(
                f"{SERVER_URL}?type=agent&model_id={MODEL_ID}",
                transports=['websocket'],
                wait_timeout=10
            )
            sio.wait()
        except Exception as e:
            print(f"[agent-{MODEL_ID}] Connection error: {e} — retrying in 5s")
            time.sleep(5)

if __name__ == '__main__':
    main()
