import { GameView } from "./GameView";

export default async function GamePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <GameView roomCode={code.toUpperCase()} />;
}
