import React from 'react';
import { useGameServer } from "@agent8/gameserver";

interface RespawnButtonProps {
  isVisible: boolean;
  onRespawn: () => void;
}

const RespawnButton: React.FC<RespawnButtonProps> = ({ isVisible, onRespawn }) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
      <div className="text-center p-6 bg-gray-800 rounded-lg shadow-lg">
        <h2 className="text-2xl font-bold text-red-500 mb-4">You Died!</h2>
        <p className="text-white mb-6">Press the button below to respawn</p>
        <button
          onClick={onRespawn}
          className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg transition-colors duration-200"
          style={{
            backgroundImage: `url(https://agent8-games.verse8.io/assets/2D/vampire_survival_riped_asset/ui/buttons/btn_red.png)`,
            backgroundSize: 'cover',
            backgroundRepeat: 'no-repeat',
            width: '150px',
            height: '50px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          Respawn
        </button>
      </div>
    </div>
  );
};

export default RespawnButton;
