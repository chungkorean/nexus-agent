/** 화면에 그대로 보여 줄 오류. status는 HTTP 상태 코드 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems?: string[],
  ) {
    super(message);
  }
}
