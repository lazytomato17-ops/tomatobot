export interface HealthResponse {
  statusCode: 200 | 503;
  body: string;
}

export function healthResponse(discordReady: boolean): HealthResponse {
  return discordReady
    ? { statusCode: 200, body: "Tomatobot is ready." }
    : { statusCode: 503, body: "Tomatobot is starting." };
}
