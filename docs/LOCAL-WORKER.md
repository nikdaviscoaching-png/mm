# Free local AI, online Seller Hub

Your website and inventory run online. This small companion processes your uploads on your Mac using its already installed Apple AI, SpeechAnalyzer, Vision, video and camera RAW frameworks. It only makes outgoing HTTPS connections. No router setup, tunnel, port forwarding or second inventory database is involved.

Open Seller Hub → Settings → Local AI and pair this Mac once. Pairing stores the website address and worker token in the private file `~/Library/Application Support/Mineral Murals/worker.json`, with permissions 0600. Never send that file or token to someone else. Its format is `{"url":"https://your-site.example","token":"your-worker-token"}`. Keep credentials outside the project and deployment ZIP.

Double-click `local-worker/Start AI Worker.command`. Leave its window open and the Mac awake. You can then upload videos and RAW photos from your phone anywhere. If the Mac sleeps, uploads remain online and jobs wait until it returns; selling and browsing continue online. The companion does not install models or buy AI credits.

Use a stationary camera. Start with an empty workspace for about 1.5 seconds. Bring one rock fully into view, hold still for 2–3 seconds, and say material, price and condition. Optional number, locality, dimensions and weight can be spoken too. Remove the rock fully and leave the workspace empty before the next one. Review each draft before publishing. Weight OCR is a candidate for confirmation, never an automatic fact.

The tested Mac has Python with Pillow and NumPy in its Codex runtime. On another Mac use Python 3.11+ with `pip install numpy Pillow` once. The Apple native helper needs macOS 26+ for on-device SpeechAnalyzer and a compatible Mac with Apple Intelligence enabled for its optional composition model. Missing model assets fall back to factual templates or manual narration; nothing is downloaded automatically. RAW uses the formats supported by macOS. Full-resolution display PNGs retain ICC color profiles, strip GPS/EXIF and preserve untouched private camera originals. RAW display rendering is 8-bit sRGB; the source retains sensor data.

No phone, cloud or browser credentials are logged. All job downloads use HTTPS with normal certificate verification; redirects to other addresses are refused. A renewable job lease avoids competing workers. Uploads larger than 8 MiB use resumable R2 multipart parts. Successful or failed job files are removed from the private Mac cache. Cloud originals remain preserved for retries.

The companion depends on your Mac for free AI processing, not for the public storefront, seller login, inventory or marketplace synchronization. Marketplace API registration and authorization are separate one-time steps.
