export interface FeedSource {
  name: string;
  url: string;
}

export const FEED_SOURCES: FeedSource[] = [
  { name: "OpenAI", url: "https://openai.com/news/rss.xml" },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { name: "Hacker News (AI)", url: "https://hnrss.org/newest?q=AI" },
  { name: "arXiv cs.AI", url: "http://export.arxiv.org/rss/cs.AI" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
];
