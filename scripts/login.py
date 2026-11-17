"""One-time local helper: log in to Telegram and print the values for the GitHub secrets.

Run on your own computer (Windows PowerShell):
    py -m pip install telethon
    py scripts\\login.py

It prints:
  * TG_SESSION: a session string that gives full access to this Telegram account. Treat it
    like a password: paste it only into the GitHub secret, never anywhere else.
  * The channels this account has joined, with the value to use for TG_CHANNELS.
"""

from __future__ import annotations

import asyncio
import getpass

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main() -> None:
    print("Get api_id and api_hash from https://my.telegram.org -> API development tools\n")
    api_id = int(input("api_id: ").strip())
    api_hash = getpass.getpass("api_hash (hidden): ").strip()

    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.start()  # asks for phone number, login code and 2FA password if enabled
    me = await client.get_me()
    print(f"\nLogged in as: {me.first_name or ''} (@{me.username or '-'})")

    print("\nChannels on this account:")
    print("-" * 72)
    rows = []
    async for d in client.iter_dialogs():
        if d.is_channel and not d.is_group:
            ref = d.entity.username or str(d.entity.id)
            rows.append((d.name, ref))
            print(f"  {d.name[:45]:<45}  ->  {ref}")
    print("-" * 72)
    print("TG_CHANNELS: put the values on the right (one per line) for the channels you want.\n")

    session = client.session.save()
    await client.disconnect()
    print("TG_SESSION (copy everything on the next line, keep it secret):\n")
    print(session)
    print()


if __name__ == "__main__":
    asyncio.run(main())
