"""Search-region audits must preserve input and never infer populated centres."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from shapely.geometry import box,mapping
from scripts.audit_search_areas import audit

class SearchAreaAuditTests(unittest.TestCase):
    def files(self,directory,features,crs=None):
        p=Path(directory)/'regions.geojson';province=Path(directory)/'provinces.geojson'
        data={'type':'FeatureCollection','features':features}
        if crs:data['crs']={'type':'name','properties':{'name':crs}}
        p.write_text(json.dumps(data),encoding='utf-8')
        province.write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature',
            'properties':{'ProvincNam':'A'},'geometry':mapping(box(50,30,52,32))}]}),encoding='utf-8')
        return p,province
    def feature(self,name,geometry,identifier=0):
        return {'type':'Feature','properties':{'Pname':'A','Cname':'County','Rname':name,
            'vcenter_na':'A named centre without coordinates','r_shenaseh':identifier},'geometry':mapping(geometry)}
    def test_zero_identifiers_do_not_collapse_distinct_areas_and_keys_survive_reordering(self):
        features=[self.feature('First',box(50.1,30.1,50.2,30.2)),self.feature('Second',box(50.3,30.3,50.4,30.4))]
        with TemporaryDirectory() as d:
            p,province=self.files(d,features);before=p.read_bytes();a=audit(p,province)
            self.assertEqual(p.read_bytes(),before)
            p,province=self.files(d,list(reversed(features)));b=audit(p,province)
        self.assertEqual(a['unique_feature_keys'],2)
        self.assertEqual(a['source_ids_requiring_fallback'],2)
        self.assertEqual(a['duplicate_feature_keys'],0)
        self.assertEqual({r['area_name']:r['feature_key'] for r in a['largest_areas']},
            {r['area_name']:r['feature_key'] for r in b['largest_areas']})
    def test_named_centre_does_not_generate_guessed_search_origins(self):
        with TemporaryDirectory() as d:
            p,province=self.files(d,[self.feature('District',box(50.1,30.1,51,31),1000040970.0)])
            report=audit(p,province,500,[30.5,50.5])
        self.assertFalse(report['has_explicit_centre_coordinate_fields'])
        self.assertEqual(report['generated_search_origins'],0)
        self.assertEqual(report['provider_requests_sent'],0)
        self.assertFalse(report['database_changed'])
        self.assertEqual(report['checked_point_matches'][0]['feature_key'],'district:1000040970')
        self.assertFalse(report['area_based_search_estimate']['exact_plan'])
    def test_unknown_crs_and_out_of_country_coordinates_require_correction(self):
        with TemporaryDirectory() as d:
            p,province=self.files(d,[self.feature('A',box(50.1,30.1,50.2,30.2))],crs='EPSG:3857')
            with self.assertRaises(ValueError):audit(p,province)
            p,province=self.files(d,[self.feature('A',box(100,30,101,31))])
            with self.assertRaises(ValueError):audit(p,province)

if __name__=='__main__':unittest.main()


class SearchSourceCompilerTests(unittest.TestCase):
    def files(self,directory):
        def feature(properties,geometry):return {'type':'Feature','properties':properties,'geometry':mapping(geometry)}
        from shapely.geometry import Point
        layers={
            'provinces':[feature(dict(Pname='A',p_center='Capital',p_shenaseh=1),box(50,35,52,37))],
            'districts':[feature(dict(pname='A',cname='County',Dname='District',d_shenaseh=2,c_shenaseh=3),box(50,35,52,37))],
            'regions':[feature(dict(Pname='A',Cname='County',Rname='West',r_shenaseh=0),box(50,35,51,37)),
                       feature(dict(Pname='A',Cname='County',Rname='East',r_shenaseh=0),box(51,35,52,37))],
            'settlements':[feature(dict(Name='Capital',ostan='A',id=0,OBJECTID=0),Point(50.5,35.5)),
                feature(dict(Name='Other',ostan='A',id=0,OBJECTID=0),Point(51.5,35.5)),
                feature(dict(Name='Mismatch',ostan='B',id=0,OBJECTID=0),Point(51.5,36.5)),
                feature(dict(Name='Outside',ostan='A',id=0,OBJECTID=0),Point(53,36))]}
        files={}
        for role,features in layers.items():
            path=Path(directory)/(role+'.geojson');path.write_text(json.dumps({'type':'FeatureCollection','features':features}),encoding='utf-8');files[role]=path
        return files
    def test_compiler_preserves_zero_ids_and_quarantines_mismatches(self):
        from backend.poi_sources import compile_catalogue
        with TemporaryDirectory() as d:
            files=self.files(d);before={k:p.read_bytes() for k,p in files.items()}
            a=compile_catalogue(files,['A']);b=compile_catalogue(files,['A'])
            self.assertEqual(a.version,b.version)
            self.assertEqual([p['id'] for p in a.settlements],[p['id'] for p in b.settlements])
            self.assertEqual(a.summary['ready'],2);self.assertEqual(a.summary['review'],2)
            self.assertEqual(a.summary['region_zero_ids_with_fallback'],2)
            self.assertEqual(a.summary['capital_anchors'],1)
            self.assertEqual(len({p['code'] for p in a.settlements}),4)
            self.assertTrue(any(r['level']=='county' and r['source_metadata']['method']=='union_of_supplied_districts' for r in a.boundaries))
            self.assertEqual(before,{k:p.read_bytes() for k,p in files.items()})
            with self.assertRaises(ValueError):compile_catalogue(files,['B'])
    def test_duplicate_coordinates_merge_only_identical_observations(self):
        from backend.poi_sources import compile_catalogue
        with TemporaryDirectory() as d:
            files=self.files(d);p=files['settlements'];data=json.loads(p.read_text());data['features'].append(data['features'][0])
            p.write_text(json.dumps(data));c=compile_catalogue(files)
            self.assertEqual(c.summary['settlements'],4);self.assertEqual(c.summary['duplicate_point_observations_merged'],1)
    def test_rejects_non_wgs84_and_invalid_geometry(self):
        from backend.poi_sources import compile_catalogue
        with TemporaryDirectory() as d:
            files=self.files(d);p=files['settlements'];data=json.loads(p.read_text())
            data['crs']={'properties':{'name':'EPSG:3857'}};p.write_text(json.dumps(data))
            with self.assertRaises(ValueError):compile_catalogue(files)
