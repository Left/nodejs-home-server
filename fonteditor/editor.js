const el = (row, col) => {
    return document.getElementById('tbl' + row + "_" + col);
};
const setVal = (row, col, val) => {
    el(row, col).style.backgroundColor = (val ? 'black' : 'white');
};
const getVal = (row, col) => {
    return el(row, col).style.backgroundColor === 'black';
};
const onClick = (row, col) => {
    // console.log(getVal(row, col));
    setVal(row, col, !getVal(row, col));
    const res = [0];
    for (let c = 0; c < 7; ++c) {
        let x = 0;
        for (let r = 7; r >= 0; --r) {
            const f = (getVal(r, c) ? 1 : 0);
            x = (x << 1) | f;
        }
        if (x !== 0) {
            res[0] = c + 1;
        }
        res.push(x);
    }
    const resv = res.map(x => '0x' + ((f) => f.length == 2 ? f : '0' + f)(x.toString(16))).join(', ');
    document.getElementById('txt').value = resv;
    // console.log(resv);
};
const textChange = (val) => {
    const v = val.split(",").map(x => x.trim()).map(x => +x);
    const size = v.shift();
    v.forEach((colData, col) => {
        for (let row = 0; row < 8; ++row) {
            const value = (colData >> row & 0x01) === 1;
            setVal(row, col, value);
        }
    });
};
window.onload = () => {
    const fld = document.getElementById('field');
    fld.innerHTML = "<table bordercolor='gray' border='2'>" + Array.from({ length: 8 }).map((e, rowIndex) => {
        return "<tr>" +
            Array.from({ length: 7 }).map((e, colIndex) => {
                return `<td 
                    height=40 
                    width=40 
                    id=${'tbl' + rowIndex + '_' + colIndex} 
                    style='background-color: white'
                    onclick='onClick(${rowIndex}, ${colIndex})'></td>`;
            }).join(" ") + "</tr>";
    }).join('\n') + "</table>";
    textChange(document.getElementById('txt').value);
};
//# sourceMappingURL=editor.js.map