import Phaser from 'phaser';
import { createGameConfig } from '../config/gameConfig';
import { loadFonts } from './fonts';
import { PrototypeScene } from './PrototypeScene';

void loadFonts().then(() => new Phaser.Game(createGameConfig([PrototypeScene], 'game')));
