class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkFrames = 2048;
    this.pending = new Float32Array(0);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (output && output.length) {
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel].fill(0);
      }
    }

    if (!input || !input.length || !input[0] || !input[0].length) {
      return true;
    }

    const frameCount = input[0].length;
    const mono = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame += 1) {
      let sample = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        sample += input[channel][frame] || 0;
      }
      mono[frame] = sample / input.length;
    }

    const combined = new Float32Array(this.pending.length + mono.length);
    combined.set(this.pending, 0);
    combined.set(mono, this.pending.length);

    let offset = 0;
    while (combined.length - offset >= this.chunkFrames) {
      const chunk = combined.slice(offset, offset + this.chunkFrames);
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
      offset += this.chunkFrames;
    }

    this.pending = combined.slice(offset);
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);