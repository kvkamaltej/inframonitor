// Build a Windows Remote Desktop (.rdp) connection file for a server. A browser can't launch
// mstsc directly, so the UI downloads this file; opening it starts the native Remote Desktop
// client connected to the host. Credentials are never embedded -- Windows prompts for them.

export function buildRdpFile(opts: { host: string; username?: string; port?: number }): string {
  const port = opts.port && opts.port > 0 ? opts.port : 3389;
  const address = `${opts.host}:${port}`;
  const lines = [
    `full address:s:${address}`,
    // Prefill the username so the client only asks for the password (blank => client decides).
    opts.username ? `username:s:${opts.username}` : "",
    "prompt for credentials:i:1",   // always prompt -- never store a password in the file
    "administrative session:i:0",
    "screen mode id:i:2",           // full screen
    "use multimon:i:0",
    "desktopwidth:i:1920",
    "desktopheight:i:1080",
    "session bpp:i:32",
    "audiomode:i:0",
    "redirectclipboard:i:1",
    "redirectprinters:i:0",
    "authentication level:i:2",
    "connection type:i:7"
  ].filter(Boolean);
  // Windows RDP files are CRLF-terminated.
  return lines.join("\r\n") + "\r\n";
}
