/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import CRC32 from 'crc-32';

export type Color = boolean;
const BLACK = true;
const WHITE = false;

export type MapCell = 'null' | 'empty';

export type Options = {
	isLlotheo: boolean;
	canPutEverywhere: boolean;
	loopedBoard: boolean;
};

export type Undo = {
	color: Color;
	pos: number;

	effects: number[];

	turn: Color | null;
};

export class Game {
	public map: MapCell[];
	public mapWidth: number;
	public mapHeight: number;
	public board: (Color | null | undefined)[];
	public turn: Color | null = BLACK;
	public opts: Options;

	public prevPos = -1;
	public prevColor: Color | null = null;

	private logs: Undo[] = [];

	constructor(map: string[], opts: Options) {
		this.putStone = this.putStone.bind(this);

		this.opts = opts;

		/* eslint-disable @typescript-eslint/no-unnecessary-condition */
		if (this.opts.isLlotheo == null) this.opts.isLlotheo = false;
		if (this.opts.canPutEverywhere == null) this.opts.canPutEverywhere = false;
		if (this.opts.loopedBoard == null) this.opts.loopedBoard = false;
		/* eslint-enable */

		this.mapWidth = map[0].length;
		this.mapHeight = map.length;
		const mapData = map.join('');

		this.board = mapData.split('').map(d => d === '-' ? null : d === 'b' ? BLACK : d === 'w' ? WHITE : undefined);

		this.map = mapData.split('').map(d => d === '-' || d === 'b' || d === 'w' ? 'empty' : 'null');

		if (!this.canPutSomewhere(BLACK)) this.turn = this.canPutSomewhere(WHITE) ? WHITE : null;
	}

	public get blackCount() {
		return this.board.filter(x => x === BLACK).length;
	}

	public get whiteCount() {
		return this.board.filter(x => x === WHITE).length;
	}

	public posToXy(pos: number): number[] {
		const x = pos % this.mapWidth;
		const y = Math.floor(pos / this.mapWidth);
		return [x, y];
	}

	public xyToPos(x: number, y: number): number {
		return x + (y * this.mapWidth);
	}

	public putStone(pos: number) {
		const color = this.turn;
		if (color == null) return;

		this.prevPos = pos;
		this.prevColor = color;

		this.board[pos] = color;

		const effects = this.effects(color, pos);

		for (const pos of effects) {
			this.board[pos] = color;
		}

		const turn = this.turn;

		this.logs.push({
			color,
			pos,
			effects,
			turn,
		});

		this.calcTurn();
	}

	private calcTurn() {
		this.turn =
			this.canPutSomewhere(!this.prevColor) ? !this.prevColor :
			this.canPutSomewhere(this.prevColor!) ? this.prevColor : //eslint-disable-line @typescript-eslint/no-non-null-assertion
			null;
	}

	public undo() {
		const undo = this.logs.pop();
		if (undo == null) return;
		this.prevColor = undo.color;
		this.prevPos = undo.pos;
		this.board[undo.pos] = null;
		for (const pos of undo.effects) {
			const color = this.board[pos];
			this.board[pos] = !color;
		}
		this.turn = undo.turn;
	}

	public mapDataGet(pos: number): MapCell {
		const [x, y] = this.posToXy(pos);
		return x < 0 || y < 0 || x >= this.mapWidth || y >= this.mapHeight ? 'null' : this.map[pos];
	}

	public getPuttablePlaces(color: Color): number[] {
		return Array.from(this.board.keys()).filter(i => this.canPut(color, i));
	}

	public canPutSomewhere(color: Color): boolean {
		return this.getPuttablePlaces(color).length > 0;
	}

	public canPut(color: Color, pos: number): boolean {
		return (
			this.board[pos] !== null ? false :
			this.opts.canPutEverywhere ? this.mapDataGet(pos) === 'empty' :
			this.effects(color, pos).length !== 0);
	}

	public effects(color: Color, initPos: number): number[] {
		const enemyColor = !color;

		const diffVectors: [number, number][] = [
			[0, -1],
			[+1, -1],
			[+1, 0],
			[+1, +1],
			[0, +1],
			[-1, +1],
			[-1, 0],
			[-1, -1],
		];

		const effectsInLine = ([dx, dy]: [number, number]): number[] => {
			const nextPos = (x: number, y: number): [number, number] => [x + dx, y + dy];

			const found: number[] = [];
			let [x, y] = this.posToXy(initPos);
			while (true) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition
				[x, y] = nextPos(x, y);

				if (this.opts.loopedBoard && this.xyToPos(
					(x = ((x % this.mapWidth) + this.mapWidth) % this.mapWidth),
					(y = ((y % this.mapHeight) + this.mapHeight) % this.mapHeight)) === initPos) {
					return found;
				} else if (x === -1 || y === -1 || x === this.mapWidth || y === this.mapHeight) return [];

				const pos = this.xyToPos(x, y);
				if (this.mapDataGet(pos) === 'null') return [];
				const stone = this.board[pos];
				if (stone === null) return [];
				if (stone === enemyColor) found.push(pos);
				if (stone === color) return found;
			}
		};

		return ([] as number[]).concat(...diffVectors.map(effectsInLine));
	}

	public calcCrc32(): number {
		return CRC32.str(JSON.stringify({
			board: this.board,
			turn: this.turn,
		}));
	}

	public get isEnded(): boolean {
		return this.turn === null;
	}

	public get winner(): Color | null {
		return this.isEnded ?
			this.blackCount === this.whiteCount ? null :
			this.opts.isLlotheo === this.blackCount > this.whiteCount ? WHITE : BLACK :
			undefined as never;
	}
}
