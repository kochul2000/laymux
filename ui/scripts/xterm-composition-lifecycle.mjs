// 이 메서드는 고정 버전 CompositionHelper 클래스 안에 삽입한다. closure나
// 모듈 전역에 의존하지 않아 ESM·CJS·Remote가 같은 구현을 실행한다.
const methods = {
  _sendImmediateCompositionKeypress(text) {
    if (!this._immediateComposition || !this._compositionEndDataAllowed) return false;
    // 일반 키는 즉시 전달하되 keypress 기본 삽입은 기존 caller가 취소한다.
    // Space를 textarea에 남기면 뒤따르는 native end가 그것까지 재송신한다.
    this._coreService.triggerDataEvent(text, true);
    return true;
  },

  _queueImmediateCompositionInput(text, isComposing) {
    if (!this._immediateComposition || !this._compositionEndDataAllowed) return false;
    // input은 이미 DOM을 변경한 관측이다. 아직 native end가 없어도 기존
    // FIFO에 넣어 다음 task에서 전달하고, 송신 기록은 native end까지 공유한다.
    this._finalizeComposition(true);
    const generation = this._pendingCompositionGenerations.at(-1);
    // 이벤트마다 DOM과 provenance를 함께 보존한다. 뒤따르는 다른 input이
    // 같은 generation의 textarea나 isComposing 의미를 덮어쓰지 않는다.
    generation.valueSnapshot = this._textarea.value;
    if (isComposing) generation.stripImmediatePrefix = true;
    generation.observations.push(text);
    return true;
  },

  textareaCleared() {
    if (!this._immediateComposition) return;
    const native = this._immediateComposition.native || this._immediateComposition;
    // 다음 줄의 같은 글자는 새 입력이다. 이전 FIFO는 이전 기록을 보유한다.
    this._immediateComposition = {
      prefix: this._immediateComposition.prefix,
      observed: "",
      textareaCleared: true,
      native,
      nativeAtClear: native.observed,
    };
  },

  _takeUnsentCompositionData(text, delivery, stripPrefix) {
    if (!delivery) return text;
    // native 조합이 이미 보낸 suffix는 Enter를 넘어 유지한다. clear 이후 새로
    // 입력한 텍스트의 기록은 별도이며 다음 clear에서만 초기화된다.
    if (stripPrefix && delivery.native) {
      this._takeUnsentCompositionData(text, delivery.native, true);
      // local 기록 역시 누적 후보를 받는다. 직전 native 호출의 delta를 넘기면
      // '글' → '글글'에서 두 번째 '글'을 같은 관측으로 잘못 제거한다.
      const snapshotAt = delivery.native.observed.indexOf(delivery.nativeAtClear);
      text =
        delivery.native.observed.slice(0, snapshotAt) +
        delivery.native.observed.slice(snapshotAt + delivery.nativeAtClear.length);
      stripPrefix = false;
    }
    // Enter가 textarea를 비운 뒤 일반 input이 와도 원래 prefix는 유지한다.
    const candidate =
      stripPrefix && text.startsWith(delivery.prefix) ? text.slice(delivery.prefix.length) : text;
    // end 전에 보낸 input과 뒤늦은 end의 관측은 같은 ordered merge로 조정한다.
    // 관측 순서와 전송 순서가 달라도 이미 관측한 부분을 다시 보내지 않는다.
    const merged = this._mergeCompositionData(delivery.observed, candidate, true);
    const sentAt = merged.indexOf(delivery.observed);
    const remaining = merged.slice(0, sentAt) + merged.slice(sentAt + delivery.observed.length);
    delivery.observed = merged;
    return remaining;
  },
};

export const compositionLifecycleMethods = Object.values(methods)
  .map((method) => method.toString())
  .join("");
