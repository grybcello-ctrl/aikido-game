import Phaser from 'phaser';
import { createGameConfig } from '../config/gameConfig';
import { PrototypeScene } from './PrototypeScene';

new Phaser.Game(createGameConfig([PrototypeScene], 'game'));
