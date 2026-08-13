# Voice conversations

Use the waveform button beside the composer to open the dedicated voice page for the current
environment and thread. The button primes browser audio during the click, then navigates; it does
not capture audio while the text-chat page remains visible. Say “Hey Mai” once to wake the
conversation, then speak commands naturally. Pause briefly to send each command.

The waveform stays listening while Mai works and speaks. To change direction, start speaking again:
Mai’s current audio and provider turn stop immediately, then your new command is captured and sent
after you pause.

Press Escape, say “go to sleep”, or choose **Sleep** to return to wake-phrase-only listening. Sleep
keeps microphone access active so Mai can hear the wake phrase. **Mic off** is different: it stops
microphone capture and releases the active browser media stream. **End** and **Return to text** stop
voice resources and return to the same text thread, where voice prompts and replies remain in normal
message history.

The configured local model-gateway transcription and speech services are the default privacy
boundary. If local audio capture is unavailable but browser speech recognition exists, T3 explains
that browser recognition may process audio online and requires an explicit opt-in; it never switches
silently. Permission denial and unsupported browsers leave the thread usable through **Continue in
text**.

This page does not use LiveKit Agents, Expressive mode, SIP, phone bridging, or Company Conductor
backend voice. Those integrations remain deferred and separate from T3's local STT/TTS gateway.
