

window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabletId = urlParams.get('id');
    const img = (document.getElementById('mainScr') as HTMLImageElement);
    
    img.src='/tablet_screen?id=' + tabletId;
    img.style.transform = 'rotate(' + [270, 0, 90, 180][tbl.orientation.get()] + 'deg)';
}