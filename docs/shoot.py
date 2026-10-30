#!/usr/bin/env python3
"""Screenshots and the demo GIF of the web console (needs: pip install playwright; playwright install chromium).

    python3 docs/shoot.py shots [URL]    every view, light and dark, at 1440 and 390 px -> docs/img/ui-*.png
    python3 docs/shoot.py demo  [URL]    search, then an index run -> docs/img/ui-demo.gif (needs ffmpeg)

The server must already have an index and a few runs of each mode (see README, "Web UI").
"""
import os
import shutil
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "img")
QUERY = "zenloulta stozenka"


def page_for(browser, theme, width, **kw):
    h = 900 if width > 600 else 844
    ctx = browser.new_context(viewport={"width": width, "height": h}, device_scale_factor=2 if width < 600 else 1,
                              color_scheme=theme, reduced_motion="reduce", **kw)
    ctx.add_init_script(f"localStorage.setItem('pm-theme', '{theme}')")
    return ctx, ctx.new_page()


def shots(url):
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        for theme in ("light", "dark"):
            for width, tag in ((1440, "desktop"), (390, "mobile")):
                ctx, pg = page_for(b, theme, width)
                pg.goto(url + "#search")
                pg.wait_for_selector(".empty, .results")
                pg.fill("#q", QUERY)
                pg.press("#q", "Enter")
                pg.wait_for_selector(".results")
                pg.evaluate("document.activeElement.blur()")
                pg.screenshot(path=f"{OUT}/ui-search-{theme}-{tag}.png", full_page=True)
                pg.goto(url + "#index")
                pg.wait_for_selector(".size")
                pg.screenshot(path=f"{OUT}/ui-index-{theme}-{tag}.png", full_page=True)
                pg.goto(url + "#benchmarks")
                pg.wait_for_selector("#chart svg, #chart .empty, #chart .notice")
                pg.screenshot(path=f"{OUT}/ui-benchmarks-{theme}-{tag}.png", full_page=True)
                pg.goto(url + "#cluster")
                pg.wait_for_selector(".node:not(.is-skeleton)")
                pg.screenshot(path=f"{OUT}/ui-cluster-{theme}-{tag}.png", full_page=True)
                ctx.close()
        b.close()


def demo(url):
    os.makedirs(OUT, exist_ok=True)
    vid = tempfile.mkdtemp()
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 760}, color_scheme="light",
                            record_video_dir=vid, record_video_size={"width": 1280, "height": 760})
        ctx.add_init_script("localStorage.setItem('pm-theme', 'light'); localStorage.removeItem('pm-recent')")
        pg = ctx.new_page()
        pg.goto(url + "#search")
        pg.wait_for_selector(".empty")
        pg.wait_for_timeout(800)
        pg.keyboard.press("Control+K")
        pg.keyboard.type(QUERY, delay=70)
        pg.wait_for_timeout(300)
        pg.keyboard.press("Enter")
        pg.wait_for_selector(".results")
        pg.wait_for_timeout(2200)
        pg.click("[data-nav=index]")
        pg.wait_for_timeout(700)
        pg.click("#mode [data-value=omp]")
        pg.wait_for_timeout(400)
        pg.click("#sizes [role=radio]:last-child")
        pg.wait_for_timeout(600)
        pg.click("#run-btn")
        pg.wait_for_selector("#run-title:has-text('Index ready')", timeout=120000)
        pg.wait_for_timeout(1800)
        pg.click("[data-nav=benchmarks]")
        pg.wait_for_selector("#chart svg")
        pg.wait_for_timeout(2200)
        ctx.close()
        b.close()
    webm = [os.path.join(vid, f) for f in os.listdir(vid) if f.endswith(".webm")][0]
    ff = shutil.which("ffmpeg") or os.environ.get("FFMPEG", "ffmpeg")
    gif = os.path.join(OUT, "ui-demo.gif")
    vf = "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle"
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", webm, "-vf", vf, gif], check=True)
    shutil.rmtree(vid)
    print(gif, os.path.getsize(gif) // 1024, "KiB")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "shots"
    url = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8080/"
    {"shots": shots, "demo": demo}[what](url)
