import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The refresh token an MCP client may use next. Null for sessions that cannot refresh.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN refresh_generation INTEGER`;
});
