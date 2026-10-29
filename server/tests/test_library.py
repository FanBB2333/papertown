from papertown.library import expand, phrases


def test_seed_is_loaded_and_tagged(town):
    assert town.library.count() > 300
    tagged = town.db.val("select count(*) from papers where tags != '[]'")
    assert tagged > town.library.count() * 0.8
    assert town.genealogy.stats().get("similar", 0) > 0


def test_chinese_idea_is_expanded():
    assert phrases("用场景图做长程任务规划") == ["scene graph", "long-horizon", "task planning"]
    assert "VLA" in expand("让 VLA 模型更稳")


def test_search_ranks_by_similarity(town):
    res = town.library.search("用场景图做机器人长程规划", top_k=5)
    assert res["method"] == "coverage" and len(res["hits"]) == 5
    sims = [h["similarity"] for h in res["hits"]]
    assert sims == sorted(sims, reverse=True) and all(0 <= x <= 1 for x in sims)
    assert any("scene graph" in h["title"].lower() or "scene-graph" in h["title"].lower() for h in res["hits"])


def test_dedup_on_ingest(town):
    p = town.library.get([town.library.latest(1)[0]["arxiv_id"]])[0]
    again = {"arxiv_id": p["arxiv_id"], "title": p["title"], "abstract": p["abstract"]}
    renamed = {"arxiv_id": "9999.00001", "title": p["title"].upper(), "abstract": ""}
    assert town.ingest([again, renamed], "arxiv") == []


def test_genealogy_expand(town):
    hit = town.library.search("scene graph planning", top_k=1)["hits"][0]
    g = town.genealogy.expand([hit["paper_id"]], depth=1)
    assert g["nodes"][0]["id"] == hit["paper_id"] and len(g["nodes"]) >= 1


def test_depot_search(town):
    res = town.depots.search("long-horizon manipulation baseline metrics")
    assert res["hits"] and res["hits"][0]["repo"].startswith("sample-lab/")
