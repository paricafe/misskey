<!--
SPDX-FileCopyrightText: syuilo and other misskey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div
	ref="rootEl"
	class="mk_grid_border"
	:class="[$style.grid, {
		[$style.noOverflowHandling]: rootSetting.noOverflowStyle,
		'mk_grid_root_rounded': rootSetting.rounded,
		'mk_grid_root_border': rootSetting.outerBorder,
	}]"
	@mousedown.prevent="onMouseDown"
	@keydown="onKeyDown"
	@contextmenu.prevent.stop="onContextMenu"
>
	<div class="mk_grid_thead">
		<MkHeaderRow
			:columns="columns"
			:gridSetting="rowSetting"
			:bus="bus"
			@operation:beginWidthChange="onHeaderCellWidthBeginChange"
			@operation:endWidthChange="onHeaderCellWidthEndChange"
			@operation:widthLargest="onHeaderCellWidthLargest"
			@change:width="onHeaderCellChangeWidth"
			@change:contentSize="onHeaderCellChangeContentSize"
		/>
	</div>
	<div class="mk_grid_tbody">
		<MkDataRow
			v-for="row in rows"
			v-show="row.using"
			:key="row.index"
			:row="row"
			:cells="cells[row.index].cells"
			:setting="rowSetting"
			:bus="bus"
			:using="row.using"
			@operation:beginEdit="onCellEditBegin"
			@operation:endEdit="onCellEditEnd"
			@change:value="onChangeCellValue"
			@change:contentSize="onChangeCellContentSize"
		/>
	</div>
</div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRefs, useTemplateRef, watch } from 'vue';
import type { DataSource, GridSetting, GridState, Size } from '@/components/grid/grid.js';
import type { CellAddress, CellValue, GridCell } from '@/components/grid/cell.js';
import type { GridContext, GridEvent } from '@/components/grid/grid-event.js';
import type { GridColumn } from '@/components/grid/column.js';
import type { GridRow, GridRowSetting } from '@/components/grid/row.js';
import type { MenuItem } from '@/types/menu.js';
import { GridEventEmitter } from '@/components/grid/grid.js';
import MkDataRow from '@/components/grid/MkDataRow.vue';
import MkHeaderRow from '@/components/grid/MkHeaderRow.vue';
import { cellValidation } from '@/components/grid/cell-validators.js';
import { CELL_ADDRESS_NONE, createCell, resetCell } from '@/components/grid/cell.js';
import {
	copyGridDataToClipboard,
	equalCellAddress,
	getCellAddress,
	getCellElement,
	pasteToGridFromClipboard,
	removeDataFromGrid,
} from '@/components/grid/grid-utils.js';
import * as os from '@/os.js';
import { createColumn } from '@/components/grid/column.js';
import { createRow, defaultGridRowSetting, resetRow } from '@/components/grid/row.js';
import { makeHotkey } from '@/utility/hotkey.js';

type RowHolder = {
	row: GridRow,
	cells: GridCell[],
	origin: DataSource,
};

const emit = defineEmits<{
	(ev: 'event', event: GridEvent, context: GridContext): void;
}>();

const props = defineProps<{
	settings: GridSetting;
	data: DataSource[];
}>();

const rootSetting: Required<GridSetting['root']> = {
	noOverflowStyle: false,
	rounded: true,
	outerBorder: true,
	...props.settings.root,
};

// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const rowSetting: Required<GridRowSetting> = {
	...defaultGridRowSetting,
	...props.settings.row,
};

// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const columnSettings = props.settings.cols;

const cellSettings = props.settings.cells ?? {};

const { data } = toRefs(props);

const bus = new GridEventEmitter();
const resizeTimeoutIds = new Set<number>();
const resizeObserver = new ResizeObserver((entries) => {
	const timeoutId = window.setTimeout(() => {
		resizeTimeoutIds.delete(timeoutId);
		onResize(entries);
	});
	resizeTimeoutIds.add(timeoutId);
});

const rootEl = useTemplateRef('rootEl');
const state = ref<GridState>('normal');
const columns = ref<GridColumn[]>(columnSettings.map(createColumn));
const rows = ref<GridRow[]>([]);
const cells = ref<RowHolder[]>([]);

const previousCellAddress = ref<CellAddress>(CELL_ADDRESS_NONE);
const editingCellAddress = ref<CellAddress>(CELL_ADDRESS_NONE);
const firstSelectionColumnIdx = ref<number>(CELL_ADDRESS_NONE.col);
const firstSelectionRowIdx = ref<number>(CELL_ADDRESS_NONE.row);

const selectedCell = computed(() => {
	const selected = cells.value.flatMap(it => it.cells).filter(it => it.selected);
	return selected.length > 0 ? selected[0] : undefined;
});
const rangedCells = computed(() => cells.value.flatMap(it => it.cells).filter(it => it.ranged));
const rangedBounds = computed(() => {
	const _cells = rangedCells.value;
	const _cols = _cells.map(it => it.address.col);
	const _rows = _cells.map(it => it.address.row);

	const leftTop = {
		col: Math.min(..._cols),
		row: Math.min(..._rows),
	};
	const rightBottom = {
		col: Math.max(..._cols),
		row: Math.max(..._rows),
	};

	return {
		leftTop,
		rightBottom,
	};
});
const availableBounds = computed(() => {
	const leftTop = {
		col: 0,
		row: 0,
	};
	const rightBottom = {
		col: Math.max(...columns.value.map(it => it.index)),
		row: Math.max(...rows.value.filter(it => it.using).map(it => it.index)),
	};
	return { leftTop, rightBottom };
});
const rangedRows = computed(() => rows.value.filter(it => it.ranged));

const lastLine = computed(() => rows.value.filter(it => it.using).length - 1);

watch(data, patchData, { deep: true });

if (_DEV_) {
	watch(state, (value, oldValue) => {
		console.log(`[grid][state] ${oldValue} -> ${value}`);
	});
}

function onResize(entries: ResizeObserverEntry[]) {
	if (entries.length !== 1 || entries[0].target !== rootEl.value) {
		return;
	}

	const contentRect = entries[0].contentRect;
	if (_DEV_) {
		console.log(`[grid][resize] contentRect: ${contentRect.width}x${contentRect.height}`);
	}

	switch (state.value) {
		case 'hidden': {
			if (contentRect.width > 0 && contentRect.height > 0) {
				state.value = 'normal';

				unSelectionRangeAll();

				bus.emit('forceRefreshContentSize');
			}
			break;
		}
		default: {
			if (contentRect.width === 0 || contentRect.height === 0) {
				state.value = 'hidden';
			}
			break;
		}
	}
}

function onKeyDown(ev: KeyboardEvent) {
	const { ctrlKey, shiftKey, code } = ev;
	if (_DEV_) {
		console.log(`[grid][key] ctrl: ${ctrlKey}, shift: ${shiftKey}, code: ${code}`);
	}

	function updateSelectionRange(newBounds: { leftTop: CellAddress, rightBottom: CellAddress }) {
		unSelectionOutOfRange(newBounds.leftTop, newBounds.rightBottom);
		expandCellRange(newBounds.leftTop, newBounds.rightBottom);
	}

	switch (state.value) {
		case 'normal': {
			ev.preventDefault();
			ev.stopPropagation();

			const selectedCellAddress = selectedCell.value?.address ?? CELL_ADDRESS_NONE;
			const max = availableBounds.value;
			const bounds = rangedBounds.value;

			makeHotkey({
				'delete': () => {
					if (rangedRows.value.length > 0) {
						if (rowSetting.events.delete) {
							rowSetting.events.delete(rangedRows.value);
						}
					} else {
						const context = createContext();
						removeDataFromGrid(context, (cell) => {
							emitCellValue(cell, undefined);
						});
					}
				},
				'ctrl+c|meta+c': () => {
					const context = createContext();
					copyGridDataToClipboard(data.value, context);
				},
				'ctrl+v|meta+v': async () => {
					const _cells = cells.value;
					const context = createContext();
					await pasteToGridFromClipboard(context, (row, col, parsedValue) => {
						emitCellValue(_cells[row.index].cells[col.index], parsedValue);
					});
				},
				'ctrl+shift+right|meta+shift+right': () => {
					updateSelectionRange({
						leftTop: { col: selectedCellAddress.col, row: bounds.leftTop.row },
						rightBottom: { col: max.rightBottom.col, row: bounds.rightBottom.row },
					});
				},
				'ctrl+shift+left|meta+shift+left': () => {
					updateSelectionRange({
						leftTop: { col: max.leftTop.col, row: bounds.leftTop.row },
						rightBottom: { col: selectedCellAddress.col, row: bounds.rightBottom.row },
					});
				},
				'ctrl+shift+up|meta+shift+up': () => {
					updateSelectionRange({
						leftTop: { col: bounds.leftTop.col, row: max.leftTop.row },
						rightBottom: { col: bounds.rightBottom.col, row: selectedCellAddress.row },
					});
				},
				'ctrl+shift+down|meta+shift+down': () => {
					updateSelectionRange({
						leftTop: { col: bounds.leftTop.col, row: selectedCellAddress.row },
						rightBottom: { col: bounds.rightBottom.col, row: max.rightBottom.row },
					});
				},
				'ctrl+right|meta+right': () => {
					selectionCell({ col: max.rightBottom.col, row: selectedCellAddress.row });
				},
				'ctrl+left|meta+left': () => {
					selectionCell({ col: max.leftTop.col, row: selectedCellAddress.row });
				},
				'ctrl+up|meta+up': () => {
					selectionCell({ col: selectedCellAddress.col, row: max.leftTop.row });
				},
				'ctrl+down|meta+down': () => {
					selectionCell({ col: selectedCellAddress.col, row: max.rightBottom.row });
				},
				'shift+right': () => {
					updateSelectionRange({
						leftTop: {
							col: bounds.leftTop.col < selectedCellAddress.col
								? bounds.leftTop.col + 1
								: selectedCellAddress.col,
							row: bounds.leftTop.row,
						},
						rightBottom: {
							col: (bounds.rightBottom.col > selectedCellAddress.col || bounds.leftTop.col === selectedCellAddress.col)
								? bounds.rightBottom.col + 1
								: selectedCellAddress.col,
							row: bounds.rightBottom.row,
						},
					});
				},
				'shift+left': () => {
					updateSelectionRange({
						leftTop: {
							col: (bounds.leftTop.col < selectedCellAddress.col || bounds.rightBottom.col === selectedCellAddress.col)
								? bounds.leftTop.col - 1
								: selectedCellAddress.col,
							row: bounds.leftTop.row,
						},
						rightBottom: {
							col: bounds.rightBottom.col > selectedCellAddress.col
								? bounds.rightBottom.col - 1
								: selectedCellAddress.col,
							row: bounds.rightBottom.row,
						},
					});
				},
				'shift+up': () => {
					updateSelectionRange({
						leftTop: {
							col: bounds.leftTop.col,
							row: (bounds.leftTop.row < selectedCellAddress.row || bounds.rightBottom.row === selectedCellAddress.row)
								? bounds.leftTop.row - 1
								: selectedCellAddress.row,
						},
						rightBottom: {
							col: bounds.rightBottom.col,
							row: bounds.rightBottom.row > selectedCellAddress.row
								? bounds.rightBottom.row - 1
								: selectedCellAddress.row,
						},
					});
				},
				'shift+down': () => {
					updateSelectionRange({
						leftTop: {
							col: bounds.leftTop.col,
							row: bounds.leftTop.row < selectedCellAddress.row
								? bounds.leftTop.row + 1
								: selectedCellAddress.row,
						},
						rightBottom: {
							col: bounds.rightBottom.col,
							row: (bounds.rightBottom.row > selectedCellAddress.row || bounds.leftTop.row === selectedCellAddress.row)
								? bounds.rightBottom.row + 1
								: selectedCellAddress.row,
						},
					});
				},
				'down': () => {
					selectionCell({ col: selectedCellAddress.col, row: selectedCellAddress.row + 1 });
				},
				'up': () => {
					selectionCell({ col: selectedCellAddress.col, row: selectedCellAddress.row - 1 });
				},
				'right': () => {
					selectionCell({ col: selectedCellAddress.col + 1, row: selectedCellAddress.row });
				},
				'left': () => {
					selectionCell({ col: selectedCellAddress.col - 1, row: selectedCellAddress.row });
				},
			}, [])(ev);

			break;
		}
	}
}

function onMouseDown(ev: MouseEvent) {
	switch (ev.button) {
		case 0: {
			onLeftMouseDown(ev);
			break;
		}
		case 2: {
			onRightMouseDown(ev);
			break;
		}
	}
}

function onLeftMouseDown(ev: MouseEvent) {
	const cellAddress = getCellAddress(ev.target as HTMLElement);
	if (_DEV_) {
		console.log(`[grid][mouse-left] state:${state.value}, button: ${ev.button}, cell: ${cellAddress.row}x${cellAddress.col}`);
	}

	switch (state.value) {
		case 'cellEditing': {
			if (availableCellAddress(cellAddress) && !equalCellAddress(editingCellAddress.value, cellAddress)) {
				selectionCell(cellAddress);
			}
			break;
		}
		case 'normal': {
			if (availableCellAddress(cellAddress)) {
				if (ev.shiftKey && selectedCell.value && !equalCellAddress(cellAddress, selectedCell.value.address)) {
					const selectedCellAddress = selectedCell.value.address;

					const leftTop = {
						col: Math.min(selectedCellAddress.col, cellAddress.col),
						row: Math.min(selectedCellAddress.row, cellAddress.row),
					};

					const rightBottom = {
						col: Math.max(selectedCellAddress.col, cellAddress.col),
						row: Math.max(selectedCellAddress.row, cellAddress.row),
					};

					unSelectionRangeAll();
					expandCellRange(leftTop, rightBottom);

					cells.value[selectedCellAddress.row].cells[selectedCellAddress.col].selected = true;
				} else {
					selectionCell(cellAddress);
				}

				previousCellAddress.value = cellAddress;

				registerMouseUp();
				registerMouseMove();
				state.value = 'cellSelecting';
			} else if (isColumnHeaderCellAddress(cellAddress)) {
				if (ev.shiftKey) {
					const rangedColumnIndexes = rangedCells.value.map(it => it.address.col);
					const targetColumnIndexes = [cellAddress.col, ...rangedColumnIndexes];
					unSelectionRangeAll();

					const leftTop = {
						col: Math.min(...targetColumnIndexes),
						row: 0,
					};

					const rightBottom = {
						col: Math.max(...targetColumnIndexes),
						row: cells.value.length - 1,
					};

					expandCellRange(leftTop, rightBottom);

					if (rangedColumnIndexes.length === 0) {
						firstSelectionColumnIdx.value = cellAddress.col;
					} else {
						if (cellAddress.col > Math.min(...rangedColumnIndexes)) {
							firstSelectionColumnIdx.value = Math.min(...rangedColumnIndexes);
						} else {
							firstSelectionColumnIdx.value = Math.max(...rangedColumnIndexes);
						}
					}
				} else {
					unSelectionRangeAll();

					const colCells = cells.value.map(row => row.cells[cellAddress.col]);
					selectionRange(...colCells.map(cell => cell.address));

					firstSelectionColumnIdx.value = cellAddress.col;
				}

				registerMouseUp();
				registerMouseMove();
				previousCellAddress.value = cellAddress;
				state.value = 'colSelecting';

				getCellElement(ev.target as HTMLElement)?.focus();
			} else if (isRowNumberCellAddress(cellAddress)) {
				if (ev.shiftKey) {
					const rangedRowIndexes = rangedRows.value.map(it => it.index);
					const targetRowIndexes = [cellAddress.row, ...rangedRowIndexes];
					unSelectionRangeAll();

					const leftTop = {
						col: 0,
						row: Math.min(...targetRowIndexes),
					};

					const rightBottom = {
						col: Math.min(...cells.value.map(it => it.cells.length - 1)),
						row: Math.max(...targetRowIndexes),
					};

					expandCellRange(leftTop, rightBottom);
					expandRowRange(Math.min(...targetRowIndexes), Math.max(...targetRowIndexes));

					if (rangedRowIndexes.length === 0) {
						firstSelectionRowIdx.value = cellAddress.row;
					} else {
						if (cellAddress.col > Math.min(...rangedRowIndexes)) {
							firstSelectionRowIdx.value = Math.min(...rangedRowIndexes);
						} else {
							firstSelectionRowIdx.value = Math.max(...rangedRowIndexes);
						}
					}
				} else {
					unSelectionRangeAll();
					const rowCells = cells.value[cellAddress.row].cells;
					selectionRange(...rowCells.map(cell => cell.address));
					expandRowRange(cellAddress.row, cellAddress.row);

					firstSelectionRowIdx.value = cellAddress.row;
				}

				registerMouseUp();
				registerMouseMove();
				previousCellAddress.value = cellAddress;
				state.value = 'rowSelecting';

				getCellElement(ev.target as HTMLElement)?.focus();
			}
			break;
		}
	}
}

function onRightMouseDown(ev: MouseEvent) {
	const cellAddress = getCellAddress(ev.target as HTMLElement);
	if (_DEV_) {
		console.log(`[grid][mouse-right] button: ${ev.button}, cell: ${cellAddress.row}x${cellAddress.col}`);
	}

	switch (state.value) {
		case 'normal': {
			if (!availableCellAddress(cellAddress)) {
				return;
			}

			const _rangedCells = [...rangedCells.value];
			if (!_rangedCells.some(it => equalCellAddress(it.address, cellAddress))) {
				selectionCell(cellAddress);
			}

			break;
		}
	}
}

function onMouseMove(ev: MouseEvent) {
	ev.preventDefault();

	const targetCellAddress = getCellAddress(ev.target as HTMLElement);
	if (equalCellAddress(previousCellAddress.value, targetCellAddress)) {
		return;
	}

	if (_DEV_) {
		console.log(`[grid][mouse-move] button: ${ev.button}, cell: ${targetCellAddress.row}x${targetCellAddress.col}`);
	}

	switch (state.value) {
		case 'cellSelecting': {
			const selectedCellAddress = selectedCell.value?.address;
			if (!availableCellAddress(targetCellAddress) || !selectedCellAddress) {
				return;
			}

			const leftTop = {
				col: Math.min(targetCellAddress.col, selectedCellAddress.col),
				row: Math.min(targetCellAddress.row, selectedCellAddress.row),
			};

			const rightBottom = {
				col: Math.max(targetCellAddress.col, selectedCellAddress.col),
				row: Math.max(targetCellAddress.row, selectedCellAddress.row),
			};

			unSelectionOutOfRange(leftTop, rightBottom);
			expandCellRange(leftTop, rightBottom);
			previousCellAddress.value = targetCellAddress;

			break;
		}
		case 'colSelecting': {
			if (!isColumnHeaderCellAddress(targetCellAddress) || previousCellAddress.value.col === targetCellAddress.col) {
				return;
			}

			const leftTop = {
				col: Math.min(targetCellAddress.col, firstSelectionColumnIdx.value),
				row: 0,
			};

			const rightBottom = {
				col: Math.max(targetCellAddress.col, firstSelectionColumnIdx.value),
				row: cells.value.length - 1,
			};

			unSelectionOutOfRange(leftTop, rightBottom);
			expandCellRange(leftTop, rightBottom);
			previousCellAddress.value = targetCellAddress;

			getCellElement(ev.target as HTMLElement)?.focus();

			break;
		}
		case 'rowSelecting': {
			if (!isRowNumberCellAddress(targetCellAddress) || previousCellAddress.value.row === targetCellAddress.row) {
				return;
			}

			const leftTop = {
				col: 0,
				row: Math.min(targetCellAddress.row, firstSelectionRowIdx.value),
			};

			const rightBottom = {
				col: Math.min(...cells.value.map(it => it.cells.length - 1)),
				row: Math.max(targetCellAddress.row, firstSelectionRowIdx.value),
			};

			unSelectionOutOfRange(leftTop, rightBottom);
			expandCellRange(leftTop, rightBottom);

			const rangedRowIndexes = [rows.value[targetCellAddress.row].index, ...rangedRows.value.map(it => it.index)];
			expandRowRange(Math.min(...rangedRowIndexes), Math.max(...rangedRowIndexes));

			previousCellAddress.value = targetCellAddress;

			getCellElement(ev.target as HTMLElement)?.focus();

			break;
		}
	}
}

function onMouseUp(ev: MouseEvent) {
	ev.preventDefault();
	switch (state.value) {
		case 'rowSelecting':
		case 'colSelecting':
		case 'cellSelecting': {
			unregisterMouseUp();
			unregisterMouseMove();
			state.value = 'normal';
			previousCellAddress.value = CELL_ADDRESS_NONE;
			break;
		}
	}
}

function onContextMenu(ev: PointerEvent) {
	const cellAddress = getCellAddress(ev.target as HTMLElement);
	if (_DEV_) {
		console.log(`[grid][context-menu] button: ${ev.button}, cell: ${cellAddress.row}x${cellAddress.col}`);
	}

	const context = createContext();
	const menuItems = Array.of<MenuItem>();
	switch (true) {
		case availableCellAddress(cellAddress): {
			const cell = cells.value[cellAddress.row].cells[cellAddress.col];
			if (cell.setting.contextMenuFactory) {
				menuItems.push(...cell.setting.contextMenuFactory(cell.column, cell.row, cell.value, context));
			}
			break;
		}
		case isColumnHeaderCellAddress(cellAddress): {
			const col = columns.value[cellAddress.col];
			if (col.setting.contextMenuFactory) {
				menuItems.push(...col.setting.contextMenuFactory(col, context));
			}
			break;
		}
		case isRowNumberCellAddress(cellAddress): {
			const row = rows.value[cellAddress.row];
			if (row.setting.contextMenuFactory) {
				menuItems.push(...row.setting.contextMenuFactory(row, context));
			}
			break;
		}
	}

	if (menuItems.length > 0) {
		os.contextMenu(menuItems, ev);
	}
}

function onCellEditBegin(sender: GridCell) {
	state.value = 'cellEditing';
	editingCellAddress.value = sender.address;
	for (const cell of cells.value.flatMap(it => it.cells)) {
		if (cell.address.col !== sender.address.col || cell.address.row !== sender.address.row) {
			cell.selected = false;
		}
	}
}

function onCellEditEnd() {
	editingCellAddress.value = CELL_ADDRESS_NONE;
	state.value = 'normal';
}

function onChangeCellValue(sender: GridCell, newValue: CellValue) {
	applyRowRules([sender]);
	emitCellValue(sender, newValue);
}

function onChangeCellContentSize(sender: GridCell, contentSize: Size) {
	const _cells = cells.value;
	if (_cells.length > sender.address.row && _cells[sender.address.row].cells.length > sender.address.col) {
		const currentSize = _cells[sender.address.row].cells[sender.address.col].contentSize;
		if (currentSize.width !== contentSize.width || currentSize.height !== contentSize.height) {
			_cells[sender.address.row].cells[sender.address.col].contentSize = contentSize;

			if (sender.column.setting.width === 'auto') {
				calcLargestCellWidth(sender.column);
			}
		}
	}
}

function onHeaderCellWidthBeginChange() {
	switch (state.value) {
		case 'normal': {
			state.value = 'colResizing';
			break;
		}
	}
}

function onHeaderCellWidthEndChange() {
	switch (state.value) {
		case 'colResizing': {
			state.value = 'normal';
			break;
		}
	}
}

function onHeaderCellChangeWidth(sender: GridColumn, width: string) {
	switch (state.value) {
		case 'colResizing': {
			const column = columns.value[sender.index];
			column.width = width;
			break;
		}
	}
}

function onHeaderCellChangeContentSize(sender: GridColumn, newSize: Size) {
	switch (state.value) {
		case 'normal': {
			const currentSize = columns.value[sender.index].contentSize;
			if (currentSize.width !== newSize.width || currentSize.height !== newSize.height) {
				columns.value[sender.index].contentSize = newSize;

				if (sender.setting.width === 'auto') {
					calcLargestCellWidth(sender);
				}
			}
			break;
		}
	}
}

function onHeaderCellWidthLargest(sender: GridColumn) {
	switch (state.value) {
		case 'normal': {
			calcLargestCellWidth(sender);
			break;
		}
	}
}

function calcLargestCellWidth(column: GridColumn) {
	const _cells = cells.value;
	const largestColumnWidth = columns.value[column.index].contentSize.width;

	const largestCellWidth = (_cells.length > 0)
		? _cells
			.map(row => row.cells[column.index])
			.reduce(
				(acc, value) => Math.max(acc, value.contentSize.width),
				0,
			)
		: 0;

	if (_DEV_) {
		console.log(`[grid][calc-largest] idx:${column.setting.bindTo}, col:${largestColumnWidth}, cell:${largestCellWidth}`);
	}

	column.width = `${Math.max(largestColumnWidth, largestCellWidth)}px`;
}

function emitGridEvent(ev: GridEvent) {
	const currentState: GridContext = {
		selectedCell: selectedCell.value,
		rangedCells: rangedCells.value,
		rangedRows: rangedRows.value,
		randedBounds: rangedBounds.value,
		availableBounds: availableBounds.value,
		state: state.value,
		rows: rows.value,
		columns: columns.value,
	};

	emit(
		'event',
		ev,
		currentState,
	);
}

function emitCellValue(sender: GridCell | CellAddress, newValue: CellValue) {
	const cellAddress = 'address' in sender ? sender.address : sender;
	const cell = cells.value[cellAddress.row].cells[cellAddress.col];

	emitGridEvent({
		type: 'cell-value-change',
		column: cell.column,
		row: cell.row,
		oldValue: cell.value,
		newValue: newValue,
	});

	if (_DEV_) {
		console.log(`[grid][cell-value] row:${cell.row}, col:${cell.column.index}, value:${newValue}`);
	}
}

function selectionCell(target: CellAddress) {
	if (!availableCellAddress(target)) {
		return;
	}

	unSelectionRangeAll();

	const _cells = cells.value;
	_cells[target.row].cells[target.col].selected = true;
	_cells[target.row].cells[target.col].ranged = true;
}

function selectionRange(...targets: CellAddress[]) {
	const _cells = cells.value;
	for (const target of targets) {
		const row = _cells[target.row];
		if (row.row.using) {
			row.cells[target.col].ranged = true;
		}
	}
}

function unSelectionRangeAll() {
	const _cells = rangedCells.value;
	for (const cell of _cells) {
		cell.selected = false;
		cell.ranged = false;
	}

	const _rows = rows.value.filter(it => it.using);
	for (const row of _rows) {
		row.ranged = false;
	}
}

function unSelectionOutOfRange(leftTop: CellAddress, rightBottom: CellAddress) {
	const safeBounds = getSafeAddressBounds({ leftTop, rightBottom });

	const _cells = rangedCells.value;
	for (const cell of _cells) {
		const outOfRangeCol = cell.address.col < safeBounds.leftTop.col || cell.address.col > safeBounds.rightBottom.col;
		const outOfRangeRow = cell.address.row < safeBounds.leftTop.row || cell.address.row > safeBounds.rightBottom.row;
		if (outOfRangeCol || outOfRangeRow) {
			cell.ranged = false;
		}
	}

	const outOfRangeRows = rows.value.filter((_, index) => index < safeBounds.leftTop.row || index > safeBounds.rightBottom.row);
	for (const row of outOfRangeRows) {
		row.ranged = false;
	}
}

function expandCellRange(leftTop: CellAddress, rightBottom: CellAddress) {
	const safeBounds = getSafeAddressBounds({ leftTop, rightBottom });
	const targetRows = cells.value.slice(safeBounds.leftTop.row, safeBounds.rightBottom.row + 1);
	for (const row of targetRows) {
		for (const cell of row.cells.slice(safeBounds.leftTop.col, safeBounds.rightBottom.col + 1)) {
			cell.ranged = true;
		}
	}
}

function expandRowRange(top: number, bottom: number) {
	if (!rowSetting.selectable) {
		return;
	}

	const targetRows = rows.value.slice(top, bottom + 1);
	for (const row of targetRows) {
		row.ranged = true;
	}
}

function applyRowRules(targetCells: GridCell[]) {
	const _rows = rows.value;
	const targetRowIdxes = [...new Set(targetCells.map(it => it.address.row))];
	const rowGroups = Array.of<{ row: GridRow, cells: GridCell[] }>();
	for (const rowIdx of targetRowIdxes) {
		const rowGroup = targetCells.filter(it => it.address.row === rowIdx);
		rowGroups.push({ row: _rows[rowIdx], cells: rowGroup });
	}

	const _cells = cells.value;
	for (const group of rowGroups.filter(it => it.row.using)) {
		const row = group.row;
		const targetCols = group.cells.map(it => it.column);
		const rowCells = _cells[group.row.index].cells;

		const newStyles = rowSetting.styleRules
			.filter(it => it.condition({ row, targetCols, cells: rowCells }))
			.map(it => it.applyStyle);

		if (JSON.stringify(newStyles) !== JSON.stringify(row.additionalStyles)) {
			row.additionalStyles = newStyles;
		}
	}
}

function availableCellAddress(cellAddress: CellAddress): boolean {
	const safeBounds = availableBounds.value;
	return cellAddress.row >= safeBounds.leftTop.row &&
		cellAddress.col >= safeBounds.leftTop.col &&
		cellAddress.row <= safeBounds.rightBottom.row &&
		cellAddress.col <= safeBounds.rightBottom.col;
}

function isColumnHeaderCellAddress(cellAddress: CellAddress): boolean {
	return cellAddress.row === -1 && cellAddress.col >= 0;
}

function isRowNumberCellAddress(cellAddress: CellAddress): boolean {
	return cellAddress.row >= 0 && cellAddress.col === -1;
}

function getSafeAddressBounds(
	bounds: { leftTop: CellAddress, rightBottom: CellAddress },
): { leftTop: CellAddress, rightBottom: CellAddress } {
	const available = availableBounds.value;

	const safeLeftTop = {
		col: Math.max(bounds.leftTop.col, available.leftTop.col),
		row: Math.max(bounds.leftTop.row, available.leftTop.row),
	};
	const safeRightBottom = {
		col: Math.min(bounds.rightBottom.col, available.rightBottom.col),
		row: Math.min(bounds.rightBottom.row, available.rightBottom.row),
	};

	return { leftTop: safeLeftTop, rightBottom: safeRightBottom };
}

function registerMouseMove() {
	unregisterMouseMove();
	addEventListener('mousemove', onMouseMove);
}

function unregisterMouseMove() {
	removeEventListener('mousemove', onMouseMove);
}

function registerMouseUp() {
	unregisterMouseUp();
	addEventListener('mouseup', onMouseUp);
}

function unregisterMouseUp() {
	removeEventListener('mouseup', onMouseUp);
}

function createContext(): GridContext {
	return {
		selectedCell: selectedCell.value,
		rangedCells: rangedCells.value,
		rangedRows: rangedRows.value,
		randedBounds: rangedBounds.value,
		availableBounds: availableBounds.value,
		state: state.value,
		rows: rows.value,
		columns: columns.value,
	};
}

function refreshData() {
	if (_DEV_) {
		console.log('[grid][refresh-data][begin]');
	}

	const _data: DataSource[] = data.value;
	const _rows: GridRow[] = (_data.length > rowSetting.minimumDefinitionCount)
		? _data.map((_, index) => createRow(index, true, rowSetting))
		: Array.from({ length: rowSetting.minimumDefinitionCount }, (_, index) => createRow(index, index < _data.length, rowSetting));
	const _cols: GridColumn[] = columns.value;

	const _cells: RowHolder[] = _rows.map(row => {
		const newCells = row.using
			? _cols.map(col => createCell(col, row, _data[row.index][col.setting.bindTo], cellSettings))
			: _cols.map(col => createCell(col, row, undefined, cellSettings));

		return { row, cells: newCells, origin: _data[row.index] };
	});

	rows.value = _rows;
	cells.value = _cells;

	const allCells = _cells.filter(it => it.row.using).flatMap(it => it.cells);
	for (const cell of allCells) {
		cell.violation = cellValidation(allCells, cell, cell.value);
	}

	applyRowRules(allCells);

	if (_DEV_) {
		console.log('[grid][refresh-data][end]');
	}
}

function patchData(newItems: DataSource[]) {
	if (_DEV_) {
		console.log('[grid][patch-data][begin]');
	}

	const _cols = columns.value;

	if (rows.value.length < newItems.length) {
		const newRows = Array.of<GridRow>();
		const newCells = Array.of<RowHolder>();

		for (let rowIdx = rows.value.length; rowIdx < newItems.length; rowIdx++) {
			const newRow = createRow(rowIdx, true, rowSetting);
			newRows.push(newRow);
			newCells.push({
				row: newRow,
				cells: _cols.map(col => createCell(col, newRow, newItems[rowIdx][col.setting.bindTo], cellSettings)),
				origin: newItems[rowIdx],
			});
		}

		rows.value.push(...newRows);
		cells.value.push(...newCells);

		applyRowRules(newCells.flatMap(it => it.cells));
	}

	const usingRows = rows.value.filter(it => it.using);
	if (usingRows.length > newItems.length) {
		for (let rowIdx = newItems.length; rowIdx < usingRows.length; rowIdx++) {
			resetRow(rows.value[rowIdx]);
			for (let colIdx = 0; colIdx < _cols.length; colIdx++) {
				const holder = cells.value[rowIdx];
				holder.origin = {};
				resetCell(holder.cells[colIdx]);
			}
		}
	}

	const changedCells = Array.of<GridCell>();
	for (let rowIdx = 0; rowIdx < newItems.length; rowIdx++) {
		const holder = cells.value[rowIdx];
		holder.row.using = true;

		const oldCells = holder.cells;
		const newItem = newItems[rowIdx];
		for (let colIdx = 0; colIdx < oldCells.length; colIdx++) {
			const _col = columns.value[colIdx];

			const oldCell = oldCells[colIdx];
			const newValue = newItem[_col.setting.bindTo];
			if (oldCell.value !== newValue) {
				oldCell.value = _col.setting.valueTransformer
					? _col.setting.valueTransformer(holder.row, _col, newValue)
					: newValue;
				changedCells.push(oldCell);
			}
		}
	}

	if (changedCells.length > 0) {
		const allCells = cells.value.slice(0, newItems.length).flatMap(it => it.cells);
		for (const cell of allCells) {
			cell.violation = cellValidation(allCells, cell, cell.value);
		}

		applyRowRules(changedCells);

		emitGridEvent({
			type: 'cell-validation',
			all: cells.value
				.filter(it => it.row.using)
				.flatMap(it => it.cells)
				.map(it => it.violation)
				.filter(it => !it.valid),
		});
	}

	if (_DEV_) {
		console.log('[grid][patch-data][end]');
	}
}

onMounted(() => {
	state.value = 'normal';

	const bindToList = columnSettings.map(it => it.bindTo);
	if (new Set(bindToList).size !== columnSettings.length) {
		throw new Error(`Duplicate bindTo setting : [${bindToList.join(',')}]}]`);
	}

	if (rootEl.value) {
		resizeObserver.observe(rootEl.value);

		const bounds = rootEl.value.getBoundingClientRect();
		if (bounds.width === 0 || bounds.height === 0) {
			state.value = 'hidden';
		}
	}

	refreshData();
});

onUnmounted(() => {
	resizeObserver.disconnect();
	for (const timeoutId of resizeTimeoutIds) {
		window.clearTimeout(timeoutId);
	}
	resizeTimeoutIds.clear();

	unregisterMouseMove();
	unregisterMouseUp();
});
</script>

<style module lang="scss">
.grid {
	font-size: 90%;
	overflow-x: scroll;
	padding-bottom: 8px;

	&.noOverflowHandling {
		overflow-x: revert;
		padding-bottom: 0;
	}
}
</style>

<style lang="scss">
.mk_grid_border {
	--rootBorderSetting: none;
	--borderRadius: 0;

	border-spacing: 0;

	&.mk_grid_root_rounded {
		--borderRadius: var(--MI-radius);
	}

	.mk_grid_thead {
		position: sticky;
    z-index: 1;
    left: 0;
		top: 0;
		-webkit-backdrop-filter: var(--MI-blur, blur(8px));
		backdrop-filter: var(--MI-blur, blur(20px));
		background: color(from var(--MI_THEME-bg) srgb r g b / 0.5);

		.mk_grid_tr {
			.mk_grid_th {

			}
		}
	}

	.mk_grid_tbody {
		.mk_grid_tr {
			&:nth-child(odd) {
				background: var(--MI_THEME-panel);
			}

			&:nth-child(even) {
				background: var(--MI_THEME-bg);
			}

			.mk_grid_td, .mk_grid_th {
				&:hover {
					box-shadow: 0 0 0 1px var(--MI_THEME-divider) inset;
				}
			}
		}
	}
}
</style>
