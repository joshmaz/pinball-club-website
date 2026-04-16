const IMAGE_BASE_PATH = "assets/images/machines";
const GAME_IMAGE_FILENAMES = {
  "300": "300.jpg",
  "The Lord of the Rings": "the-lord-of-the-rings.jpg",
  "Target Pool": "target-pool.jpg",
  "Metallica (Pro)": "metallica-pro.jpg",
  "KISS (Pro)": "kiss-pro.jpg",
  "PIN-BOT": "pin-bot.jpg",
  "Doodle Bug": "doodle-bug.jpg",
  "World Cup Soccer": "world-cup-soccer.jpg",
  "Grand Prix": "grand-prix.jpg",
  "Last Action Hero": "last-action-hero.png",
  "World Poker Tour": "world-poker-tour.jpg",
  "NBA Fastbreak": "nba-fastbreak.jpg",
  "Hokus Pokus": "hokus-pokus.jpg",
  NASCAR: "nascar.jpg",
  "Johnny Mnemonic": "johnny-mnemonic.jpg",
  "Space Shuttle": "space-shuttle.jpg",
  "High Speed": "high-speed.jpg",
  "The Getaway: High Speed II": "the-getaway-high-speed-ii.png",
  "The Bally Game Show": "the-bally-game-show.jpg",
  "Hot Line": "hot-line.jpg",
  "The Simpsons Pinball Party": "the-simpsons-pinball-party.png",
  "Lost World": "lost-world.jpg",
  "Count-Down": "count-down.jpg",
  "Terminator 2: Judgment Day": "terminator-2-judgment-day.png",
  Argosy: "argosy.png",
  Genie: "genie.png",
  "Jacks Open": "jacks-open.png",
  Apollo: "apollo.png",
  "Flight 2000": "flight-2000.png",
  "Target Alpha": "target-alpha.png",
  Airborne: "airborne.png",
  "Hot Shot": "hot-shot.png",
  "Major League": "major-league.jpg",
  Robocop: "robocop.jpg",
  "Time Warp": "time-warp.jpg",
  "Flash Gordon": "flash-gordon.jpg",
  "Star Trek": "star-trek.jpg",
  "Swords of Fury": "swords-of-fury.jpg",
  "WHO dunnit": "who-dunnit.jpg",
  "The Lost World Jurassic Park": "the-lost-world-jurassic-park.jpg",
  Congo: "congo.gif",
  Aztec: "aztec.jpg",
  Flash: "flash.jpg",
  Genesis: "genesis.jpg",
  "Strikes and Spares": "strikes-and-spares.jpg",
  "The Flintstones": "the-flintstones.jpg",
  "Judge Dredd": "judge-dredd.jpg",
  Firepower: "firepower.jpg",
  "Total Nuclear Annihilation": "total-nuclear-annihilation.jpg",
  Cleopatra: "cleopatra.jpg",
  "Old Chicago": "old-chicago.jpg"
};

const currentGames = [
  { title: "Target Pool", details: "1969 Gottlieb EM. Design by Ed Krynski. 2 flippers, 1 pop bumper, 27 standup targets." },
  { title: "World Cup Soccer", details: "1994 Williams DMD. Design by John Popadiuk and Larry DeMar. 2 flippers, 2 ramps, spinning soccer ball, goalie target." },
  { title: "Grand Prix", details: "1976 Williams EM. Design by Steve Kordek. 2 flippers, 2 spinners, 2 pop bumpers." },
  { title: "Last Action Hero", details: "1993 Data East solid state. Design by Tim Seckel, Joe Kaminkow, Ed Cebula, and John Borg. 2 flippers, 3 pop bumpers, 1 ramp, 6-ball multiball." },
  { title: "World Poker Tour", details: "2006 Stern DMD. Designed by Steve Ritchie and Keith P. Johnson. 4 flippers, 3 pop bumpers, 16 drop targets, ace hole." },
  { title: "NBA Fastbreak", details: "1997 Bally DMD. Design by George Gomez. 3 flippers including one backbox flipper, 3 ramps, 4 up-kickers." },
  { title: "Charlie's Angels", details: "1978 Gottlieb solid state. Design by Allen Edwall. 2 flippers, 2 pop bumpers, 8 drop targets." },
  { title: "Hokus Pokus", details: "1976 Bally EM. Design by Greg Kmiec. 2 flippers, 2 pop bumpers, 3 stand-up targets, 3 spinners." },
  { title: "NASCAR", details: "2005 Stern DMD. Designed by Pat Lawlor. 2 flippers, 2 ramps, 3 pop bumpers, motor speedway." },
  { title: "Johnny Mnemonic", details: "1995 Williams DMD. Design by George Gomez. 2 flippers, 2 ramps, magnetic glove toy." },
  { title: "300", details: "1975 Gottlieb EM. Design by Ed Krynski. 2 flippers, 2 pop bumpers, 2 standup targets, mechanical backbox animation." },
  { title: "Hot Line", details: "1966 Williams EM. Design by Steve Kordek. 2 flippers, 5 pop bumpers, 17 rollover buttons." },
  { title: "Sorcerer", details: "1985 Williams solid state. Design by Mark Ritchie. 2 flippers, 3 pop bumpers, 1 ramp, 2-ball multiball." },
  { title: "Count-Down", details: "1979 Gottlieb solid state. Design by Ed Krynski. 4 flippers, 1 pop bumper, drop target banks." },
  { title: "Terminator 2: Judgment Day", details: "1991 Williams DMD. Design by Steve Ritchie. 2 flippers, 3 pop bumpers, 2 ramps." },
  { title: "Genie", details: "1979 Gottlieb solid state. Design by Ed Krynski. 5 flippers, 3 pop bumpers, 11 drop targets." },
  { title: "Jacks Open", details: "1977 Gottlieb EM. Design by Ed Krynski. 2 flippers, 3 pop bumpers, 9 drop targets, no slingshots." },
  { title: "Apollo", details: "1967 Williams EM. Design by Norm Clark. 2 flippers, 4 pop bumpers, 7 standup targets." },
  { title: "Flight 2000", details: "1980 Stern Electronics solid state. Design by Harry Williams. 2 flippers, 2 pop bumpers, 5 drop targets, 3-ball multiball." }
];

const previousGames = [
  { title: "Space Shuttle", details: "1980 Williams solid state. Design by Barry Oursler and Joe Kaminkow. 2 flippers, 4 pop bumpers, 1 ramp, multiball." },
  { title: "High Speed", details: "1986 Williams solid state. Design by Steve Ritchie. 3 flippers, 3 pop bumpers, 1 ramp, standup banks." },
  { title: "The Getaway: High Speed II", details: "1992 Williams DMD. Design by Steve Ritchie. 3 flippers, 3 pop bumpers, 2 ramps, supercharger." },
  { title: "The Bally Game Show", details: "1990 Bally solid state. Design by Dan Langlois and Peter Perry. 2 flippers, 2 ramps, 2-ball multiball." },
  { title: "Metallica (Pro)", details: "2013 Stern DMD. Design by John Borg. 2 flippers, 2 ramps, in-line drop targets." },
  { title: "KISS (Pro)", details: "2015 Stern DMD. Designed by John Borg. 2 flippers, 2 ramps, 4 pop bumpers, spinning disk." },
  { title: "PIN-BOT", details: "1986 Williams solid state. Design by Barry Oursler and Python Anghelo. 2 flippers, 5-drop bank, 3 kickout holes, 2-ball multiball." },
  { title: "Doodle Bug", details: "1971 Williams EM. Design by Norm Clark. 2 flippers, 5 pop bumpers, 5 standup targets." },
  { title: "The Simpsons Pinball Party", details: "2003 Stern DMD. Designed by Keith P. Johnson and Joe Balcer. 5 flippers, 4 ramps, custom callouts from the TV cast." },
  { title: "Lost World", details: "1977 Bally solid state. Design by Gary Gayton. 2 flippers, 3 pop bumpers, 2 saucers, spinner." },
  { title: "Argosy", details: "1977 Williams EM. Design by Chris Otis. 2 flippers, 1 spinner, 2 pop bumpers, 1 saucer." },
  { title: "Target Alpha", details: "1976 Gottlieb EM. Design by Ed Krynski. 4 flippers, 2 pop bumpers, 15 drop targets." },
  { title: "Airborne", details: "1996 Capcom solid state. Design by Claude Fernandez. 2 flippers and many ramps." },
  { title: "Hot Shot", details: "1973 Gottlieb solid state. Design by Ed Krynski. 2 flippers, 1 pop bumper, 14 drop targets, saucer." },
  { title: "2001", details: "1971 Gottlieb solid state. Design by Ed Krynski. 2 flippers, 2 pop bumpers, 20 drop targets." },
  { title: "Fun Land", details: "1971 Gottlieb solid state. Design by Ed Krynski. 2 flippers, 2 pop bumpers, 2 spinners." },
  { title: "Major League", details: "1963 Williams EM. 1 bat flipper, 7 hanging targets, 1 ramp." },
  { title: "The Lord of the Rings", details: "2003 Stern DMD. Designed by George Gomez, Keith P. Johnson, and Chris Granner. 2 flippers, 3 ramps, 3 pop bumpers, One Ring toy." },
  { title: "The Hobbit (Smaug)", details: "2016 Jersey Jack widebody. 27-inch HD LCD in backbox and upper playfield display. 3 flippers, 3 pop bumpers, 11 independent drop targets." },
  { title: "Robocop", details: "1989 Data East solid state. Design by Joe Kaminkow and Ed Cebula. 2 flippers, 3 pop bumpers, jump ramp, spinner, 3-ball multiball." },
  { title: "Time Warp", details: "1979 Williams EM. Design by Barry Oursler. 2 banana flippers, 5 pop bumpers." },
  { title: "Flash Gordon", details: "1981 Bally solid state. Design by Claude Fernandez. 3 flippers, 3 pop bumpers, in-line targets." },
  { title: "Ice Fever", details: "1985 Gottlieb solid state. Design by John Trudeau. 2 flippers, 4 pop bumpers, captive ball behind drop targets." },
  { title: "Star Trek", details: "1991 Data East solid state. Design by Joe Kaminkow and Ed Cebula. 2 flippers, 3 pop bumpers, 3-ball multiball." },
  { title: "X-Men Wolverine LE", details: "2012 Stern DMD. Designed by John Borg. 3 flippers, 2 ramps, 3 pop bumpers, Wolverine bash toy." },
  { title: "Roy Clark The Entertainer", details: "1977 Fascination solid state cocktail table. 2 flippers, 3 pop bumpers, 4 drop targets." },
  { title: "Swords of Fury", details: "1988 Williams solid state. 4 flippers, no pop bumpers, mini-playfield, 5-bank drop targets." },
  { title: "Baywatch", details: "1995 Sega DMD. Design by Joe Kaminkow and Joe Balcer. 3 flippers plus shark flipper, 3 ramps, 5-ball multiball." },
  { title: "WHO dunnit", details: "1995 Williams DMD. Design by Dwight Sullivan and Barry Oursler. 2 flippers, 2 ramps." },
  { title: "The Lost World Jurassic Park", details: "1997 Sega DMD. Design by John Borg. 2 flippers, 2 ramps." },
  { title: "Congo", details: "1995 Williams DMD. Design by John Trudeau. 3 flippers, 2 ramps, gorilla sub-playfield." },
  { title: "Time Machine", details: "1988 Data East solid state. Design by Joe Kaminkow and Ed Cebula. 2 flippers, 3 pop bumpers, 3 ramps, chime box." },
  { title: "Aztec", details: "1976 Williams EM. 2 flippers, 2 pop bumpers, 6 standup targets, spinner." },
  { title: "Street Fighter II", details: "1993 Gottlieb Premier solid state. 5 flippers, three-level playfield, bash car." },
  { title: "Flash", details: "1979 Williams solid state. Design by Steve Ritchie. 3 flippers, 3 pop bumpers, 1 spinner." },
  { title: "Volley", details: "1976 Gottlieb EM. Design by Ed Krynski. 2 flippers, 3 pop bumpers, 15 drop targets." },
  { title: "Genesis", details: "1993 Gottlieb Premier solid state. Design by John Trudeau. 2 flippers, 4 pop bumpers, 2 ramps." },
  { title: "Evil Knievel", details: "1976 Bally solid state. Design by Gary Gayton. 2 flippers, 3 pop bumpers, 5-bank drop targets, 2 spinners." },
  { title: "Strikes and Spares", details: "1978 Bally solid state. 2 flippers, 3 pop bumpers, 10 star rollover buttons." },
  { title: "Ship Ahoy", details: "1976 Gottlieb EM. Design by Ed Krynski. 2 flippers, 2 pop bumpers, 2 stand-up targets, spinner." },
  { title: "The Flintstones", details: "1994 Williams DMD. Design by John Trudeau. 3 flippers, 2 ramps, bowling alley toy." },
  { title: "Judge Dredd", details: "1993 Williams DMD widebody. Design by John Trudeau. 4 flippers, 2 ramps, 6-ball multiball." },
  { title: "Firepower", details: "1980 Williams solid state. Design by Steve Ritchie. 2 flippers, 4 pop bumpers, 3-ball multiball." },
  { title: "Total Nuclear Annihilation", details: "2017 Spooky Pinball. Designed by Scott Danesi. 3 flippers, 1 pop bumper, in-line drop targets." },
  { title: "Cleopatra", details: "1977 Gottlieb solid state. Design by Ed Krynski. 2 flippers, 3 pop bumpers, 5 drop targets, 2 saucers." },
  { title: "F-14 Tomcat", details: "1987 Williams solid state. Design by Steve Ritchie. 4 flippers, 1 pop bumper, 4-ball multiball." },
  { title: "Old Chicago", details: "1976 Bally EM. Design by Greg Kmiec. 2 flippers, 5 pop bumpers, standup targets, drop targets, spinner." }
];

function createGamesList(games) {
  const list = document.createElement("ul");
  list.className = "games-list";

  for (const game of games) {
    const item = document.createElement("li");
    item.className = "games-list-item";

    const title = document.createElement("strong");
    title.textContent = game.title;
    item.appendChild(title);

    const filename = GAME_IMAGE_FILENAMES[game.title];
    const imagePath = filename ? `${IMAGE_BASE_PATH}/${filename}` : "";
    if (imagePath) {
      const image = document.createElement("img");
      image.className = "game-card-image";
      image.src = imagePath;
      image.alt = game.title;
      image.loading = "lazy";
      item.appendChild(image);
    }

    const details = document.createElement("p");
    details.className = "games-details";
    details.textContent = game.details;
    item.appendChild(details);

    list.appendChild(item);
  }

  return list;
}

function renderGames() {
  const currentContainer = document.getElementById("games-current");
  const previousContainer = document.getElementById("games-previous");

  if (currentContainer) {
    currentContainer.replaceChildren(createGamesList(currentGames));
  }
  if (previousContainer) {
    previousContainer.replaceChildren(createGamesList(previousGames));
  }
}

renderGames();
