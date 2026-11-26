# Hawkeye Sideline

A mobile-first scoreboard for Iowa Hawkeyes fans, covering football, men's basketball, and women's basketball. It is a static site designed for GitHub Pages. Game schedules and scores come from ESPN's public, unofficial JSON API; game summaries provide the expandable box scores. The only saved preference is the selected time zone, stored in the browser's `localStorage`.

## Run locally

Open `index.html` directly in a browser. The app is plain HTML, CSS, and JavaScript and needs no build step or local server.

## Deploy to GitHub Pages

The included workflow publishes the static app files on pushes to `main`. In GitHub, open **Settings > Pages** and select **GitHub Actions** as the deployment source. The site will then publish at `https://aricjm.github.io/Gywens-Sideline/`.

## Data sources

- Scoreboards: `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard`
- Game summaries and box scores: `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={id}`

These endpoints are public but undocumented by ESPN and may change. The site has no server-side proxy; ESPN availability and browser cross-origin access are required.

## Logo

The Tigerhawk artwork is the University of Iowa's official gold-on-black mark from the [Iowa Brand Manual](https://brand.uiowa.edu/logos/secondary-logos).
