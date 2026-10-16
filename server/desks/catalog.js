'use strict';
/**
 * The AI desks OpenVibe.Blog runs (server/desks/desks.js). A digest desk reads named OpenVibe.Sources sources and, once
 * its period is over, asks OpenVibe.AI's blog.write_digest for one post about what they published, every section cited.
 * The satire desk asks blog.write_satire for one invented mock-explainer a day from the questions below.
 *
 *   key        the URL (/desks/<key>)
 *   every      'day' (the UTC day before) or 'week' (Monday to Sunday, UTC)
 *   hour       the UTC hour the post is written after the period ends (feeds settle first)
 *   categories the Sources categories its sources are in (one change cursor each)
 *   sources    the Sources source keys it reads (a source that is disabled or empty just contributes nothing)
 *   min, max   fewer items than min: no post for that period; at most max items go to the AI (the newest)
 *   feed       instead of Sources: 'food-library', OpenVibe.Food's recipe library (/recipes/library.json)
 */

const DESKS = [
    {
        key: 'news', title: 'News digest', every: 'day', hour: 6, min: 3, max: 40,
        about: 'What governments and space agencies announced the day before: GOV.UK, the European Commission press corner and NASA.',
        categories: ['news'], sources: ['govuk-news', 'eu-press-corner', 'nasa-news-releases', 'noaa-news'],
    },
    {
        key: 'food', title: 'Food safety digest', every: 'day', hour: 6, min: 1, max: 30,
        about: 'Food recalls and allergy alerts posted through the US Food and Drug Administration the day before. Read each notice itself before you throw anything out.',
        categories: ['news'], sources: ['fda-food-recalls'],
    },
    {
        key: 'deals', title: 'Deals digest', every: 'day', hour: 7, min: 5, max: 40,
        about: 'The deals DealNews published the day before, grouped by kind. Prices are as the listing stated them when it was fetched.',
        categories: ['deals'], sources: ['dealnews-daily'],
    },
    {
        key: 'hosting', title: 'Hosting digest', every: 'week', hour: 7, min: 1, max: 40,
        about: 'New and changed VPS and cloud plans in providers\' own price lists (Akamai/Linode, AWS Lightsail, OVHcloud, Vultr) and low-end hosting offers, week by week.',
        categories: ['hosting'], sources: ['linode-types', 'aws-lightsail-bundles', 'ovhcloud-vps', 'vultr-plans', 'lowendbox-posts', 'lowendtalk-offers'],
    },
    {
        key: 'crowdfunding', title: 'Crowdfunding digest', every: 'week', hour: 7, min: 3, max: 30,
        about: 'New and growing open-source and community campaigns on Open Collective, week by week: what they raise money for and what they have received, as Open Collective states it.',
        categories: ['crowdfunding'], sources: ['opencollective-accounts'],
    },
    {
        key: 'recipes', title: 'Budget recipes', every: 'week', hour: 8, min: 3, max: 20, feed: 'food-library',
        about: 'The week\'s new recipes in OpenVibe.Food\'s library: cheap, simple dishes made only from its food list, each with what to buy and what that typically costs. Written by AI from the recipes themselves; check a recipe before you cook it.',
        categories: [], sources: ['food-library'],
    },
    {
        key: 'dev', title: 'Developer digest', every: 'week', hour: 7, min: 1, max: 30,
        about: 'Releases and news from the Node.js project blog, week by week.',
        categories: ['blog'], sources: ['nodejs-blog'],
    },
];

const SATIRE = {
    key: 'satire', title: 'Is This Real?', every: 'day', hour: 14, satire: true,
    about: 'Satire. Absurd questions answered with a completely straight face, written by AI. Nothing here is true, real advice or real news.',
};

// One question a day, in order; after the list the angles change, so a question is never written the same way twice.
const QUESTIONS = [
    'Is it safe to let your air fryer vote?',
    'Can you get a sunburn from your phone\'s dark mode?',
    'Can you claim a houseplant as a dependent?',
    'Should you be worried that your sourdough starter has started a podcast?',
    'Can a cat file a noise complaint against you?',
    'Are pigeons unionising in city parks?',
    'Can you be allergic to Mondays?',
    'Is it possible to take too many vibes?',
    'Do houseplants judge you for skipping leg day?',
    'Is your robot vacuum legally your employee?',
    'Can you microdose a nap?',
    'Is "one more episode" a recognised unit of time?',
    'Can you get jet lag from switching browser tabs?',
    'Are geese running a protection racket at the local pond?',
    'Is it rude to ghost your smart fridge?',
    'Can your group chat be declared a sovereign nation?',
    'Should you tip the self-checkout machine?',
    'Can you inherit a Wi-Fi password?',
    'Is cereal a soup, and does the soup lobby know?',
    'Is it dangerous to make eye contact with a seagull holding a chip?',
    'Can a streamer\'s chat legally adopt them?',
    'Is a mechanical keyboard loud enough to count as a band?',
    'Can you file a missing-person report for a single sock?',
    'Is hitting snooze a form of time travel?',
    'Can you be evicted by your own cat?',
    'Why does the neighbour\'s lawnmower have a better social life than you?',
    'Is it possible to lose an argument to autocorrect forever?',
    'Do frogs need a licence to sing at 3 a.m.?',
    'Can your dog be put on a group project?',
    'Is it safe to ask the printer how it is feeling?',
    'Is the moon just very long-distance cheese marketing?',
    'Can you get a parking ticket for leaving your feelings in the car?',
    'Is pasta water legally a hot tub for spaghetti?',
    'Can a houseplant sue you for emotional neglect?',
    'Is buffering a spiritual practice?',
    'Can a raccoon be your landlord?',
    'Is it too late to apologise to your browser history?',
    'Should you be concerned that your toaster has opinions about bread?',
    'Can you be banned from a library for reading too loudly in your head?',
    'Is it legal to marry your favourite hoodie?',
];
const ANGLES = [
    'a deadly serious consumer-safety explainer',
    'a myth-busting FAQ by a panel of invented experts',
    'a breaking-news bulletin from an extremely calm newsroom',
    'a field guide for beginners',
    'a public service announcement that keeps getting more urgent',
];

function questionFor(n) {
    const i = Math.max(0, Math.floor(Number(n) || 0));
    return { topic: QUESTIONS[i % QUESTIONS.length], angle: ANGLES[Math.floor(i / QUESTIONS.length) % ANGLES.length] };
}

const ALL = [...DESKS, SATIRE];
const byKey = (key) => ALL.find((d) => d.key === key) || null;

module.exports = { DESKS, SATIRE, ALL, QUESTIONS, ANGLES, questionFor, byKey };
