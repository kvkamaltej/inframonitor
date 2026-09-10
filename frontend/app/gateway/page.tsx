"use client";

import { AppShell } from "@/components/app-shell";
import { GatewayPage } from "@/components/gateway-page";

export default function GatewayRoute() {
  return (
    <AppShell title="Gateway Traffic" subtitle="Who is calling the API gateway, and what the rate limiter is doing about it">
      {({ token, me }) => <GatewayPage token={token} me={me} />}
    </AppShell>
  );
}
