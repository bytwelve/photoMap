type JpegParserMode =
  | 'entropy'
  | 'entropy-marker'
  | 'marker-code'
  | 'marker-prefix'
  | 'segment-data'
  | 'segment-length-high'
  | 'segment-length-low'
  | 'soi-code'
  | 'soi-prefix';

interface JpegParserState {
  mode: JpegParserMode;
  segmentFromEntropy: boolean;
  segmentLengthHigh: number;
  segmentMarker: number;
  segmentRemaining: number;
}

interface JpegChunkResult {
  endOffset?: number;
  invalid?: true;
}

export function createJpegParserState(): JpegParserState {
  return {
    mode: 'soi-prefix',
    segmentFromEntropy: false,
    segmentLengthHigh: 0,
    segmentMarker: 0,
    segmentRemaining: 0,
  };
}

export function consumeJpegChunk(
  state: JpegParserState,
  bytes: Buffer,
  absoluteStart: number,
): JpegChunkResult {
  for (let index = 0; index < bytes.length; index += 1) {
    if (state.mode === 'entropy') {
      const markerPrefix = bytes.indexOf(0xff, index);
      if (markerPrefix < 0) return {};
      index = markerPrefix;
      state.mode = 'entropy-marker';
      continue;
    }
    if (state.mode === 'segment-data') {
      const consumed = Math.min(state.segmentRemaining, bytes.length - index);
      state.segmentRemaining -= consumed;
      index += consumed - 1;
      if (state.segmentRemaining === 0) completeJpegSegment(state);
      continue;
    }

    const value = bytes[index]!;
    const absoluteOffset = absoluteStart + index;
    switch (state.mode) {
      case 'soi-prefix':
        if (value !== 0xff) return { invalid: true };
        state.mode = 'soi-code';
        break;
      case 'soi-code':
        if (value !== 0xd8) return { invalid: true };
        state.mode = 'marker-prefix';
        break;
      case 'marker-prefix':
        if (value !== 0xff) return { invalid: true };
        state.mode = 'marker-code';
        break;
      case 'marker-code': {
        if (value === 0xff) break;
        const result = beginJpegMarker(state, value, false, absoluteOffset);
        if (result.endOffset !== undefined || result.invalid === true) return result;
        break;
      }
      case 'segment-length-high':
        state.segmentLengthHigh = value;
        state.mode = 'segment-length-low';
        break;
      case 'segment-length-low': {
        const segmentLength = state.segmentLengthHigh * 256 + value;
        if (segmentLength < 2) return { invalid: true };
        state.segmentRemaining = segmentLength - 2;
        if (state.segmentRemaining === 0) completeJpegSegment(state);
        else state.mode = 'segment-data';
        break;
      }
      case 'entropy-marker': {
        if (value === 0x00) {
          state.mode = 'entropy';
          break;
        }
        if (value === 0xff) break;
        if (isJpegRestartMarker(value)) {
          state.mode = 'entropy';
          break;
        }
        const result = beginJpegMarker(state, value, true, absoluteOffset);
        if (result.endOffset !== undefined || result.invalid === true) return result;
        break;
      }
    }
  }
  return {};
}

function beginJpegMarker(
  state: JpegParserState,
  marker: number,
  fromEntropy: boolean,
  markerCodeOffset: number,
): JpegChunkResult {
  if (marker === 0xd9) return { endOffset: markerCodeOffset + 1 };
  if (marker === 0x00) return { invalid: true };
  if (marker === 0xd8 || marker === 0x01 || isJpegRestartMarker(marker)) {
    state.mode = fromEntropy ? 'entropy' : 'marker-prefix';
    return {};
  }
  state.segmentMarker = marker;
  state.segmentFromEntropy = fromEntropy;
  state.mode = 'segment-length-high';
  return {};
}

function completeJpegSegment(state: JpegParserState): void {
  state.mode = state.segmentMarker === 0xda
    || (state.segmentMarker === 0xdc && state.segmentFromEntropy)
    ? 'entropy'
    : 'marker-prefix';
}

function isJpegRestartMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}
