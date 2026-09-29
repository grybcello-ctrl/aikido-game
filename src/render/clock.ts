/**
 * 실시간(performance.now 계열) → 게임 가상시간 매핑.
 * 배속 변경·일시정지 시점마다 기준점을 다시 잡는 구간 선형 함수라서,
 * 입력 이벤트 타임스탬프도 같은 함수로 변환하면 슬로모션에서도 ms 오차가 정확히 유지된다.
 */
export class GameClock {
  private realRef: number;
  private virtRef = 0;
  private rate = 1;
  private paused = false;

  constructor(realNow: number) {
    this.realRef = realNow;
  }

  get scale(): number {
    return this.paused ? 0 : this.rate;
  }

  toVirtual(real: number): number {
    return this.virtRef + (real - this.realRef) * this.scale;
  }

  setScale(scale: number, real: number): void {
    this.rebase(real);
    this.rate = scale;
  }

  pause(real: number): void {
    if (this.paused) return;
    this.rebase(real);
    this.paused = true;
  }

  resume(real: number): void {
    if (!this.paused) return;
    this.rebase(real);
    this.paused = false;
  }

  private rebase(real: number): void {
    this.virtRef = this.toVirtual(real);
    this.realRef = real;
  }
}
