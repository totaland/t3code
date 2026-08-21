# Voice conversations

Use the waveform button beside the composer to open `/voice/<environmentId>/<threadId>` for the
current environment and thread. The button primes browser audio during the click, then navigates;
it does not capture audio while the text-chat page remains visible. Say “Hey Mai” once to wake the
conversation, then speak commands naturally. Pause briefly to send each command.

Local capture requires sustained voiced audio before it asks the transcription gateway to decode a
segment. Silence, near-silence, and duplicate completion events are discarded, so they cannot create
messages or restart a transcription loop. Spoken phrases such as “thank you” and “amen” remain valid;
T3 uses audio evidence rather than a phrase blacklist.

The waveform stays listening while Mai works and speaks. To change direction, start speaking again:
Mai’s current audio and provider turn stop immediately, then your new command is captured and sent
after you pause.

Press Escape, say “go to sleep”, or choose **Sleep** to return to wake-phrase-only listening. Sleep
keeps microphone access active so Mai can hear the wake phrase. **Mic off** is different: it stops
microphone capture and releases the active browser media stream. **End** and **Return to text** stop
voice resources and return to the same text thread, where voice prompts and replies remain in normal
message history. An unsent composer draft does not block voice entry and remains unchanged when you
return to text.

The configured local model-gateway transcription and speech services are the default privacy
boundary. If local transcription is unavailable but browser speech recognition exists, T3 explains
that browser recognition may process audio online and requires an explicit opt-in; it never switches
silently. Permission denial and unsupported browsers leave the thread usable through **Continue in
text**.

Configure the T3 server, not the browser:

```dotenv
T3CODE_MODEL_GATEWAY_URL="http://127.0.0.1:8091"
T3CODE_MODEL_GATEWAY_API_KEY="the same value as backend-voice MODEL_GATEWAY_API_KEY"
```

Remote microphone access requires a secure browser context. Use HTTPS rather than plain Tailnet
HTTP. The API key stays server-side, and the voice proxy routes require an authenticated T3 session
with environment operate scope.

This browser page does not use LiveKit Agents, Expressive mode, SIP, or Company Conductor backend
voice. A separate authenticated `/api/voice/phone/*` lab surface can accept bounded transcript turns
from a loopback phone bridge. T3 keeps its short conversation history in memory and runs each reply
through the selected Codex provider in an empty temporary workspace with a private temporary Codex
home; command, web, app, image, skill-install, and subagent capabilities are disabled. The phone
surface never receives telephone audio and is not the user's interactive T3 thread. Telephony,
Whisper, TTS, destination policy, and lifecycle listening remain the bridge's responsibility.
