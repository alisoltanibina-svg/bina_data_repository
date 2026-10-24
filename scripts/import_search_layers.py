"""Audit/import four local search-source layers. Defaults to no database writes."""
import argparse
import json
from pathlib import Path
import sys
from backend.poi_geo import load_boundaries
from backend.poi_sources import ROOT,DEFAULT_FILES,compile_catalogue

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=ROOT/'data')
    parser.add_argument('--apply',action='store_true',help='Import immutable source snapshots; never starts collection')
    args=parser.parse_args()
    _,provinces=load_boundaries(ROOT/'data/iran.geojson')
    files={role:args.directory/path.name for role,path in DEFAULT_FILES.items()}
    catalogue=compile_catalogue(files,[p['name'] for p in provinces])
    imported=False
    if args.apply:
        from backend.database import db_session
        with db_session() as session:
            from backend.poi import control
            c=control(session)
            if not c.paused or c.in_flight:raise SystemExit('Pause collection and wait for the dispatched request before importing')
            from backend.poi_sources import save_catalogue
            imported=save_catalogue(session,catalogue)
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps({'version':catalogue.version,'imported':imported,'database_changed':imported,
        'summary':catalogue.summary},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
