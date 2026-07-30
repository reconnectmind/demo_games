import { protocolGames } from "@gamespace/games";
import { describeContract } from "./contract-suite.js";

for (const game of protocolGames) describeContract(protocolGames, game);
